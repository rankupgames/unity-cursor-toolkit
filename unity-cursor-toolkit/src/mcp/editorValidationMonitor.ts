/** Independent, bounded observation of the selected Editor. No Unity API or VS Code dependency. */
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import * as path from 'path';
import type { ICommandSender, ToolResult } from '../core/interfaces';
import { readOwnedUnityEditorLogPath } from '../core/unityEditorLauncher';
import type { UnityEditorFocus, UnityEditorFocusState } from '../core/unityEditorFocus';
import { resolveProjectRoot } from './standaloneProjectTools';

const MAX_BYTES = 64 * 1024;
const FRESH_MS = 15_000;
const TIMEOUT_MS = 120_000;
const RESULT_PATH = 'TestResults/UnityCursorToolkit/EditorValidation/latest.json';
/** Main-thread silence that must pass before the Editor is focused. A domain reload alone is shorter. */
const FOCUS_SILENCE_MS = 5_000;
const FOCUS_RETRY_MS = 10_000;
const FOCUS_MAX_ATTEMPTS = 2;
/** A bridge-loss episode that no request owns stops recovering after this long. */
const RECOVERY_EPISODE_MS = 60_000;
type ScheduleObservation = (callback: () => void, delayMs: number) => () => void;
type WatchResult = (filename: string, changed: () => void, failed: () => void) => () => void;
const scheduleObservation: ScheduleObservation = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
};

type RecoveryState = 'disabled' | 'idle' | 'focusing' | 'waiting_for_main_thread' | 'recovered' | 'failed';

export interface EditorBridgeObservation {
	transportConnected: boolean;
	port?: number | null;
	lastMainThreadResponse: number;
	projectInfo?: Record<string, unknown>;
}

export class EditorValidationMonitor {
	private requestedAt = 0;
	private currentOperationId = '';
	public get operationId(): string { return this.currentOperationId; }
	private requestOpen = false;
	private requestExpired = false;
	private delivery = 'not_requested';
	private probing = false;
	private lastProbe = 0;
	private liveResult: Record<string, unknown> | undefined;
	private logPath: string | undefined;
	private logOffset = 0;
	private logIdentity = '';
	private logRemainder = '';
	private logReset = false;
	private logEvidence: 'unknown' | 'compiling' | 'failed' | 'reloading' = 'unknown';
	private diagnostics: Record<string, unknown>[] = [];
	private resultEvidence = 'unavailable';
	private disposed = false;
	private recoveryOpen = false;
	private recoveryStartedAt = 0;
	private focusInFlight = false;
	private focusAttempts = 0;
	private focusStopped = false;
	private lastFocusAt = 0;
	private lastFocusState: UnityEditorFocusState | 'none' = 'none';
	private recoveryState: RecoveryState;
	private recoveryReason = '';
	private cancelObservation: (() => void) | undefined;
	private recoveryGeneration = 0;
	private cancelWatch: (() => void) | undefined;
	private automaticObservation: 'stopped' | 'watching' | 'unavailable' = 'stopped';
	private observedOperationId = '';

	constructor(
		private readonly sender: ICommandSender,
		private readonly bridge: () => EditorBridgeObservation,
		private readonly projectRoot = resolveProjectRoot(),
		private readonly configuredLogPath = process.env.UNITY_CURSOR_TOOLKIT_EDITOR_LOG_PATH,
		private readonly now: () => number = Date.now,
		/** Recovery is off unless a focus function is injected. */
		private readonly focusEditor?: UnityEditorFocus,
		private readonly schedule: ScheduleObservation = scheduleObservation,
		private readonly watchResult: WatchResult = watchValidationResult
	) {
		this.recoveryState = focusEditor == null ? 'disabled' : 'idle';
	}

	/** Watch only this project's validation output. Idle observation has no timer or TCP polling. */
	public start(): void {
		if (this.disposed || this.cancelWatch != null) { return; }
		this.readLog(true);
		this.automaticObservation = 'watching';
		this.cancelWatch = this.watchResult(path.join(this.projectRoot, RESULT_PATH), () => {
			if (!this.disposed) { void this.status(); }
		}, () => { this.automaticObservation = 'unavailable'; });
		// A server can attach after an automatic compile has already started.
		this.readResult(this.bridge());
	}

	/** Stops all recovery. A focus attempt already in flight is ignored when it returns. */
	public dispose(): void {
		this.disposed = true;
		this.requestOpen = false;
		this.recoveryOpen = false;
		this.recoveryGeneration++;
		this.cancelObservation?.();
		this.cancelObservation = undefined;
		this.cancelWatch?.();
		this.cancelWatch = undefined;
		this.automaticObservation = 'stopped';
	}

	/**
	 * Opens a bounded recovery episode after a command found the bridge lost. It sends nothing to Unity,
	 * so a possibly accepted command is never replayed and compilation is never requested.
	 */
	public recover(): void {
		if (this.disposed || this.recoveryOpen || this.requestOpen) { return; }
		this.startRecoveryEpisode();
		this.recoveryOpen = true;
		this.observeInBackground();
	}

	/** Called once before dispatch; a dropped response never causes a replay. */
	public beginRequest(): boolean {
		if (this.disposed || this.requestOpen) { return false; }
		this.requestedAt = this.now();
		this.currentOperationId = randomBytes(16).toString('hex');
		this.requestOpen = true;
		this.requestExpired = false;
		this.delivery = 'unconfirmed';
		this.startRecoveryEpisode();
		this.liveResult = undefined;
		// Establish a byte boundary before dispatch so old diagnostics cannot complete this request.
		this.readLog(true);
		this.logEvidence = 'unknown';
		this.diagnostics = [];
		this.observeInBackground();
		return true;
	}

	public acceptResponse(response: Record<string, unknown> | null): void {
		if (response == null) { return; }
		const result = objectValue(response.result);
		if (result != null && this.matchesProject(result)) {
			if (this.delivery !== 'observed_automatic') { this.delivery = 'accepted'; }
			this.observeResult(result);
		}
	}

	public async status(): Promise<ToolResult> {
		// Probe in the background. Status does not await TCP, compilation, or the Editor main thread.
		this.probe();
		const observation = this.bridge();
		this.readResult(observation);
		this.readLog(false);
		const result = this.liveResult;
		const projectVerified = observation.transportConnected && typeof observation.projectInfo?.projectPath === 'string'
			&& path.resolve(observation.projectInfo.projectPath) === path.resolve(this.projectRoot);
		const reportedPid = observation.projectInfo?.editorProcessId;
		const mainThreadReady = projectVerified && this.now() - observation.lastMainThreadResponse < FRESH_MS
			&& observation.lastMainThreadResponse > 0 && observation.lastMainThreadResponse >= (this.requestOpen ? this.requestedAt : 0)
			&& observation.lastMainThreadResponse >= (Date.parse(String(result?.finishedUtc)) || 0);
		const compilerFailed = this.logEvidence === 'failed' || result?.status === 'failed' || Number(result?.errorCount ?? 0) > 0;
		const compilationCompleted = result?.compilationCompleted === true;
		const reloadCompleted = result?.reloadCompleted === true;
		const reloadOnly = result?.syncMethod === 'automatic_reload';
		const blocked = result?.status === 'blocked';
		const resultAge = this.now() - Date.parse(String(result?.observedUtc));
		const resultFresh = Number.isFinite(resultAge) && resultAge >= -1_000 && resultAge <= FRESH_MS;
		const succeeded = mainThreadReady && resultFresh && !compilerFailed && (compilationCompleted || reloadOnly) && reloadCompleted && result?.status === 'succeeded';
		const timedOut = !compilerFailed && !blocked && !succeeded
			&& (this.requestExpired || (this.requestOpen && this.now() - this.requestedAt >= TIMEOUT_MS));
		if (timedOut) { this.requestExpired = true; }
		const inconclusive = timedOut || result?.status === 'inconclusive';
		const pending = !compilerFailed && !succeeded && !inconclusive && !blocked && (this.requestOpen || result?.pending === true);
		const status = compilerFailed ? 'failed' : succeeded ? 'succeeded' : blocked ? 'blocked' : inconclusive ? 'inconclusive'
			: compilationCompleted || this.logEvidence === 'reloading' ? 'reloading'
			: this.logEvidence === 'compiling' || result?.isCompiling === true ? 'compiling'
			: pending ? 'waiting_for_compile' : 'unknown';
		this.recoverFocus(observation, mainThreadReady, !compilerFailed && !blocked && !succeeded && !inconclusive);
		if ((compilerFailed || blocked || inconclusive) && this.recoveryState !== 'disabled' && this.recoveryState !== 'recovered') {
			this.recoveryState = 'failed';
			this.recoveryReason = timedOut ? 'Main-thread recovery was not confirmed before the observation timeout.'
				: 'Recovery stopped because validation failed, was blocked, or was inconclusive.';
		}
		const editorFocused = typeof result?.editorFocused === 'boolean' ? result.editorFocused : null;
		const payload = {
			success: succeeded, tool: 'editor_validation', status, pending,
			isCompiling: status === 'compiling', syncMethod: result?.syncMethod ?? '', finishedUtc: result?.finishedUtc ?? '',
			resultPath: path.join(this.projectRoot, RESULT_PATH), operationId: this.requestOpen ? this.currentOperationId : result?.operationId ?? '',
			projectPath: this.projectRoot, requestedUtc: this.requestOpen ? new Date(this.requestedAt).toISOString() : result?.requestedUtc ?? null,
			requestDelivery: this.delivery, automaticObservation: this.automaticObservation,
			compilerStatus: compilerFailed ? 'failed' : compilationCompleted ? 'succeeded' : reloadOnly ? 'not_requested' : status === 'compiling' ? 'compiling' : 'unknown',
			reloadStatus: reloadCompleted ? 'completed' : compilationCompleted || this.logEvidence === 'reloading' ? 'pending' : 'unknown',
			transportConnected: observation.transportConnected, mainThreadReady, editorFocused,
			connectedPort: projectVerified ? observation.port ?? null : null,
			editorProcessId: projectVerified && typeof reportedPid === 'number' && Number.isSafeInteger(reportedPid) && reportedPid > 0 ? reportedPid : null,
			recovery: { state: this.recoveryState, focusAttempts: this.focusAttempts, lastFocus: this.lastFocusState, reason: this.recoveryReason },
			suspectedFocusWait: pending && editorFocused === false && !mainThreadReady,
			errorCount: Math.max(this.diagnostics.length, Number(result?.errorCount ?? 0)), warningCount: result?.warningCount ?? 0,
			diagnostics: this.diagnostics, resultEvidence: this.resultEvidence, logAvailable: this.logPath != null, logReset: this.logReset,
			message: compilerFailed ? 'Compiler errors observed for the selected project.' : succeeded ? reloadOnly ? 'Domain reload observed. No script compilation was requested.' : 'Compilation and domain reload observed.'
				: timedOut ? 'No conclusive completion evidence before the observation timeout. The request was not replayed.'
					: blocked || inconclusive ? String(result?.message ?? 'Validation was blocked or inconclusive.')
						: 'Observing the selected Editor independently. Transport reachability does not prove main-thread readiness.'
		};
		if (compilerFailed || succeeded || timedOut || result?.status === 'blocked' || result?.status === 'inconclusive') {
			this.requestOpen = false;
			this.recoveryOpen = false;
			this.cancelObservation?.();
			this.cancelObservation = undefined;
		}
		return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: compilerFailed || inconclusive || blocked };
	}

	/** Progress continues while the caller is awaiting Unity or is not polling status. */
	private observeInBackground(): void {
		if (this.disposed || this.cancelObservation != null || !(this.requestOpen || this.recoveryOpen)) { return; }
		this.cancelObservation = this.schedule(() => {
			this.cancelObservation = undefined;
			void this.status().then(() => this.observeInBackground(), () => {
				this.requestOpen = false;
				this.recoveryOpen = false;
				this.recoveryState = 'failed';
			});
		}, 1_000);
	}

	private startRecoveryEpisode(): void {
		this.recoveryGeneration++;
		this.recoveryStartedAt = this.now();
		this.focusAttempts = 0;
		this.focusStopped = false;
		this.lastFocusAt = 0;
		this.lastFocusState = 'none';
		this.recoveryState = this.focusEditor == null ? 'disabled' : 'idle';
		this.recoveryReason = '';
	}

	/**
	 * Focuses the selected Editor when the caller's request or recovery episode is active and its main thread stays silent.
	 * Focus is never proof of success: only a later main-thread response from the selected project ends the episode.
	 */
	private recoverFocus(observation: EditorBridgeObservation, mainThreadReady: boolean, unresolved: boolean): void {
		if (this.disposed) { return; }
		const now = this.now();
		if (!this.requestOpen && !(this.recoveryOpen && now - this.recoveryStartedAt < RECOVERY_EPISODE_MS)) {
			if (this.recoveryOpen) {
				this.recoveryOpen = false;
				if (this.recoveryState !== 'recovered' && this.recoveryState !== 'disabled') {
					this.recoveryState = 'failed';
					this.recoveryReason = 'No fresh main-thread response arrived before recovery expired.';
				}
			}
			return;
		}
		if (mainThreadReady) {
			if (observation.lastMainThreadResponse > Math.max(this.recoveryStartedAt, this.lastFocusAt)) {
				this.recoveryState = 'recovered';
				this.recoveryReason = 'A fresh main-thread response arrived from the selected project.';
				this.recoveryOpen = false;
			}
			return;
		}
		if (this.focusEditor == null) { return; }
		const projectPath = observation.projectInfo?.projectPath;
		if (!unresolved || this.focusInFlight || this.focusStopped || this.focusAttempts >= FOCUS_MAX_ATTEMPTS) { return; }
		if (typeof projectPath === 'string' && path.resolve(projectPath) !== path.resolve(this.projectRoot)) { return; }
		const silentSince = Math.max(observation.lastMainThreadResponse, this.requestOpen ? this.requestedAt : this.recoveryStartedAt);
		if (now - silentSince < FOCUS_SILENCE_MS || (this.lastFocusAt > 0 && now - this.lastFocusAt < FOCUS_RETRY_MS)) { return; }
		this.focusInFlight = true;
		this.focusAttempts++;
		this.lastFocusAt = now;
		this.recoveryState = 'focusing';
		const generation = this.recoveryGeneration;
		const pid = observation.projectInfo?.editorProcessId;
		void this.focusEditor({ projectRoot: this.projectRoot, ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { expectedPid: pid } : {}) })
			.then(outcome => outcome, () => ({ state: 'failed' as const, reason: 'The native focus request failed.' }))
			.then(outcome => {
				this.focusInFlight = false;
				if (this.disposed || generation !== this.recoveryGeneration || !(this.requestOpen || this.recoveryOpen) || this.recoveryState === 'recovered') { return; }
				const state = outcome.state;
				this.lastFocusState = state;
				this.recoveryState = state === 'activated' ? 'waiting_for_main_thread' : 'failed';
				this.recoveryReason = outcome.reason;
				// Activation and transient failures may retry. Identity, permission and unsupported outcomes stop focus.
				if (state !== 'activated' && state !== 'failed') {
					this.focusStopped = true;
					this.recoveryOpen = false;
				}
			});
	}

	private probe(): void {
		if (this.disposed || this.probing || this.now() - this.lastProbe < 1_000) { return; }
		this.probing = true;
		this.lastProbe = this.now();
		void this.sender.request('mcpToolCall', { toolName: 'editor_validation', args: { action: 'status' } })
			.then(response => this.acceptResponse(response), () => undefined)
			.finally(() => { this.probing = false; });
	}

	private matchesProject(result: Record<string, unknown>): boolean {
		return typeof result.projectPath === 'string'
			&& typeof result.status === 'string' && ['idle', 'running', 'compiling', 'reloading', 'succeeded', 'failed', 'blocked', 'inconclusive'].includes(result.status)
			&& typeof result.pending === 'boolean'
			&& (result.errorCount == null || (typeof result.errorCount === 'number' && Number.isInteger(result.errorCount) && result.errorCount >= 0))
			&& (result.warningCount == null || (typeof result.warningCount === 'number' && Number.isInteger(result.warningCount) && result.warningCount >= 0))
			&& path.resolve(result.projectPath) === path.resolve(this.projectRoot)
			&& (!this.requestOpen || result.operationId === this.currentOperationId);
	}

	private observeResult(result: Record<string, unknown>): void {
		if (Date.parse(String(result.observedUtc)) < Date.parse(String(this.liveResult?.observedUtc))) { return; }
		if (!this.requestOpen && result.operationId !== this.liveResult?.operationId) {
			// A later automatic compile owns a new batch. Earlier log errors cannot fail it.
			this.readLog(true);
			this.logEvidence = 'unknown';
			this.diagnostics = [];
			this.requestExpired = false;
		}
		// File events can coalesce a quick compile into its terminal result. It still needs a fresh main-thread reply.
		const automaticWork = result.pending === true || (result.status === 'succeeded' && result.reloadCompleted === true);
		if (!this.requestOpen && this.automaticObservation !== 'stopped' && automaticWork
			&& typeof result.operationId === 'string' && result.operationId.length > 0 && result.operationId !== this.observedOperationId) {
			this.currentOperationId = result.operationId;
			this.requestedAt = this.now();
			this.requestOpen = true;
			this.delivery = 'observed_automatic';
			this.startRecoveryEpisode();
			this.observeInBackground();
		}
		if (typeof result.operationId === 'string') { this.observedOperationId = result.operationId; }
		if (result.pending === false) { this.requestExpired = false; }
		this.liveResult = result;
	}

	private readResult(observation: EditorBridgeObservation): void {
		const filename = path.join(this.projectRoot, RESULT_PATH);
		if (observation.projectInfo?.editorSessionId != null && this.liveResult?.editorSessionId !== observation.projectInfo.editorSessionId) { this.liveResult = undefined; }
		try {
			const stat = fs.statSync(filename);
			if (stat.size > MAX_BYTES) { this.resultEvidence = 'oversized'; return; }
			const result = objectValue(fs.readFileSync(filename, 'utf8'));
			if (result == null || !this.matchesProject(result)) { this.resultEvidence = 'mismatched_or_incomplete'; return; }
			const age = this.now() - Date.parse(String(result.observedUtc));
			if (!Number.isFinite(age) || age < -1_000 || age > FRESH_MS) { this.resultEvidence = 'stale'; return; }
			if (observation.projectInfo?.editorSessionId != null && result.editorSessionId !== observation.projectInfo.editorSessionId) {
				this.resultEvidence = 'different_editor_session'; return;
			}
			this.resultEvidence = 'fresh_project_status';
			this.observeResult(result);
			if (this.requestOpen && this.delivery !== 'observed_automatic') { this.delivery = 'accepted'; }
		} catch { this.resultEvidence = 'unavailable_or_partial'; }
	}

	private readLog(baselineOnly: boolean): void {
		const info = this.bridge().projectInfo;
		const selected = this.configuredLogPath ?? (typeof info?.editorLogPath === 'string' ? info.editorLogPath : this.logPath ?? readOwnedUnityEditorLogPath(this.projectRoot) ?? undefined);
		if (selected == null || !path.isAbsolute(selected)) { return; }
		let fd: number | undefined;
		try {
			const stat = fs.statSync(selected);
			const identity = `${stat.dev}:${stat.ino}`;
			if (this.logPath == null && this.now() - stat.mtimeMs > FRESH_MS && !baselineOnly) { return; }
			const firstRead = this.logPath == null;
			const changed = selected !== this.logPath || identity !== this.logIdentity || stat.size < this.logOffset;
			if (changed) {
				this.logReset = this.logPath != null;
				this.logPath = selected;
				this.logIdentity = identity;
				this.logRemainder = '';
				this.logEvidence = 'unknown';
				this.diagnostics = [];
				this.logOffset = Math.max(0, stat.size - MAX_BYTES);
			}
			if (baselineOnly || (firstRead && this.requestedAt === 0)) { this.logOffset = stat.size; this.logRemainder = ''; return; }
			if (stat.size === this.logOffset) { return; }
			let skippedBytes = false;
			if (stat.size - this.logOffset > MAX_BYTES) {
				skippedBytes = true;
				this.logOffset = stat.size - MAX_BYTES;
				this.logRemainder = '';
				this.logReset = true;
			}
			fd = fs.openSync(selected, 'r');
			const bytes = Buffer.alloc(Math.min(MAX_BYTES, stat.size - this.logOffset));
			const count = fs.readSync(fd, bytes, 0, bytes.length, this.logOffset);
			const skipPartial = this.logOffset > 0 && (changed || skippedBytes) && this.logRemainder.length === 0;
			this.logOffset += count;
			const lines = (this.logRemainder + bytes.subarray(0, count).toString('utf8')).split('\n');
			this.logRemainder = (lines.pop() ?? '').slice(-MAX_BYTES);
			if (skipPartial) { lines.shift(); }
			// Never expose startup arguments or unrelated raw log lines.
			for (const line of lines) {
				const error = /^(.+?)\((\d+),(\d+)\): error (CS\d+): (.{0,1000})/.exec(line.trim());
				if (error != null) {
					this.logEvidence = 'failed';
					this.diagnostics.push({ file: error[1], line: Number(error[2]), column: Number(error[3]), code: error[4], message: error[5] });
					this.diagnostics = this.diagnostics.slice(-50);
				} else if (/^Reloading assemblies|^Begin MonoManager ReloadAssembly/.test(line)) {
					if (this.logEvidence !== 'failed') { this.logEvidence = 'reloading'; }
				} else if (/^\[ScriptCompilation\]|^Starting script compilation/.test(line)) {
					this.logEvidence = 'compiling'; this.diagnostics = [];
				}
			}
		} catch { /* Missing/inaccessible logs remain unknown, never successful. */ }
		finally { if (fd != null) { fs.closeSync(fd); } }
	}
}

/** Follow directory creation and atomic result replacement without creating project files. */
const watchValidationResult: WatchResult = (filename, changed, failed) => {
	let watcher: fs.FSWatcher | undefined;
	let stopped = false;
	const attach = (): void => {
		watcher?.close();
		if (stopped) { return; }
		let directory = path.dirname(filename);
		while (!fs.existsSync(directory) && path.dirname(directory) !== directory) { directory = path.dirname(directory); }
		const child = path.relative(directory, filename).split(path.sep)[0];
		try {
			const current = fs.watch(directory, { persistent: false }, (event, name) => {
				if (stopped) { return; }
				if (name == null || String(name) === child || (event === 'rename' && String(name) === path.basename(directory))) {
					if (event === 'rename') { attach(); }
					changed();
				}
			});
			watcher = current;
			current.on('error', () => { if (watcher === current) { current.close(); failed(); } });
		} catch { failed(); }
	};
	attach();
	return () => { stopped = true; watcher?.close(); };
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
		return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch { return undefined; }
}
