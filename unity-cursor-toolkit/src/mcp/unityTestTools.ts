import * as crypto from 'crypto';
import * as path from 'path';
import type { ICommandSender, IToolProvider, ToolCallContext, ToolDefinition, ToolResult } from '../core/interfaces';
import { UnityCliTestAdapter } from '../core/unityCliTestAdapter';
import { redactUnityTestText } from '../core/unityTestPrivacy';
import type { UnityTestRequest, UnityTestSnapshot, UnityTestCase } from '../core/unityTestTypes';
import { getToolAnnotations } from './toolMetadata';
import { resolveProjectRoot } from './standaloneProjectTools';

const object = (value: unknown): Record<string, unknown> | undefined => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const terminal = new Set(['listed', 'completed', 'failed', 'cancelled', 'timed_out', 'error']);
const sameProject = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** One policy boundary shared by the extension commands and standalone MCP server. */
export class UnityTestMcpTools implements IToolProvider {
	public readonly toolGroupName = 'tests';
	private readonly active = new Set<string>();
	constructor(private readonly sender: ICommandSender,
		private readonly projectRoot: () => string | undefined = resolveProjectRoot,
		private readonly cli = new UnityCliTestAdapter(), private readonly readOnly = false) {}

	public getTools(): ToolDefinition[] {
		const properties = {
			projectPath: { type: 'string', description: 'Exact Unity project root. Defaults to the linked project.' },
			mode: { type: 'string', enum: ['EditMode', 'PlayMode'] },
			filter: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['assembly', 'namespace', 'class', 'test', 'category'].map(key => [key, { type: 'string', minLength: 1 }])) },
			backend: { type: 'string', enum: ['auto', 'cli', 'bridge'], default: 'auto' },
			timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, default: 600000 }
		};
		return ['list_tests', 'run_tests'].map(name => ({ name, title: name === 'list_tests' ? 'List Unity Tests' : 'Run Unity Tests',
			description: name === 'list_tests' ? 'Discover exact test names through the connected Editor. Filters combine with AND; namespace includes descendants. The pinned CLI cannot list tests.'
				: 'Run selected Unity tests with one backend. dryRun lists the selection without execution. CLI supports test/class/namespace filters; bridge also supports assembly/category. A failed backend never switches automatically.',
			inputSchema: { type: 'object', additionalProperties: false, properties: name === 'run_tests' ? { ...properties, dryRun: { type: 'boolean', default: false } } : properties, required: ['mode'] },
			annotations: getToolAnnotations(name) }));
	}

	public async handleToolCall(name: string, args: Record<string, unknown>, context: ToolCallContext = {}): Promise<ToolResult> {
		const snapshot = await this.execute(name, args, context);
		return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], isError: !snapshot.success };
	}

	public async execute(name: string, args: Record<string, unknown>, context: ToolCallContext = {}): Promise<UnityTestSnapshot> {
		const requested = args.backend ?? 'auto';
		const projectPath = args.projectPath ?? this.projectRoot();
		const snapshot: UnityTestSnapshot = { success: false, backend: requested === 'cli' ? 'cli' : 'bridge', runId: crypto.randomBytes(16).toString('hex'),
			status: 'error', editorVersion: '', mode: args.mode === 'EditMode' || args.mode === 'PlayMode' ? args.mode : null,
			selection: [], tests: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: 0 } };
		const fail = (code: string, message: string, recovery = 'Check the selected backend and project before retrying.'): UnityTestSnapshot => ({ ...snapshot, success: false,
			status: code === 'cancelled' ? 'cancelled' : code === 'timed_out' ? 'timed_out' : 'error', error: { code, message, recovery } });
		const filters = args.filter === undefined ? undefined : object(args.filter);
		const timeoutMs = args.timeoutMs ?? 600000;
		if (!['list_tests', 'run_tests'].includes(name) || !snapshot.mode || !['auto', 'cli', 'bridge'].includes(String(requested))
			|| typeof projectPath !== 'string' || !projectPath.trim() || /[\0\r\n]/.test(projectPath)
			|| typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000
			|| Object.keys(args).some(key => !['projectPath', 'mode', 'filter', 'backend', 'timeoutMs', ...(name === 'run_tests' ? ['dryRun'] : [])].includes(key))
			|| args.dryRun !== undefined && typeof args.dryRun !== 'boolean'
			|| args.filter !== undefined && (!filters || Object.entries(filters).some(([key, value]) => !['assembly', 'namespace', 'class', 'test', 'category'].includes(key) || typeof value !== 'string' || !value.length || value.length > 4096 || /[\0\r\n]/.test(value)))) {
			return fail('invalid_test_request', 'Provide a supported mode, backend, project path, literal filters and bounded timeout.');
		}
		const list = name === 'list_tests' || args.dryRun === true;
		if (this.readOnly && !list) { return fail('policy_refused', 'Test execution is blocked in read-only mode.', 'Use list_tests or dryRun=true.'); }
		if (context.signal?.aborted) { return fail('cancelled', 'The test request was cancelled before execution.'); }
		const key = process.platform === 'win32' ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath);
		if (this.active.has(key)) { return fail('test_run_active', 'This provider already owns a test request for the project.'); }
		this.active.add(key);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		context.signal?.addEventListener('abort', onAbort, { once: true });
		let expired = false;
		let owner: Record<string, unknown> | undefined;
		let finished = false;
		const stopOwned = async (): Promise<boolean> => {
			if (!owner || finished) { return true; }
			const deadline = Date.now() + 15000;
			let action = 'cancel';
			do {
				const reply = await this.sender.request('mcpToolCall', { toolName: 'test_runner', args: { action, ...owner } });
				const parsed = this.readSnapshot(reply?.result, snapshot, Number(owner.editorPid), projectPath);
				if (parsed && terminal.has(parsed.status) && object(reply?.result)?.workStopped !== false && (parsed.status !== 'error' || object(reply?.result)?.workStopped === true)) { finished = true; return true; }
				action = 'status';
				await new Promise(resolve => setTimeout(resolve, 250));
			} while (Date.now() < deadline);
			return false;
		};
		const stoppedError = async (code: string, message: string): Promise<UnityTestSnapshot> => {
			let confirmed = false;
			try { confirmed = await stopOwned(); } catch { /* The owned Editor must be inspected after transport failure. */ }
			return confirmed ? fail(code, message) : fail('cancellation_unconfirmed', 'The owned run could not be confirmed stopped.', 'Inspect the same Editor before retrying; no other backend was started.');
		};
		const cliRun = async (request: UnityTestRequest): Promise<UnityTestSnapshot> => {
			const result = await this.cli.runTests({ ...request, onSelected: version => context.reportProgress?.(0, 0, 'cli ' + version + ': selected') });
			return expired && result.status === 'cancelled' ? { ...result, status: 'timed_out', error: { code: 'timed_out', message: 'The test request deadline expired.', recovery: 'Inspect the interrupted run before retrying.' } } : result;
		};
		const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
		const interruptible = (pending: Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> => new Promise((resolve, reject) => {
			const stop = () => resolve(null);
			if (controller.signal.aborted) { pending.catch(() => undefined); resolve(null); return; }
			controller.signal.addEventListener('abort', stop, { once: true });
			pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop)).catch(() => undefined);
		});
		try {
			const request: UnityTestRequest = { projectPath, mode: snapshot.mode, filters, timeoutMs, signal: controller.signal, dryRun: list };
			if (requested === 'cli') { return list ? await this.cli.listTests(request) : await cliRun(request); }
			const reply = await interruptible(this.sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'capabilities', projectPath } }));
			const capabilities = object(reply?.result);
			if (controller.signal.aborted) { return fail(expired ? 'timed_out' : 'cancelled', 'The test request ended before backend selection.'); }
			// Only absence or a valid unavailable advertisement can select CLI before execution.
			if (reply == null && requested === 'auto' && !list) { return await cliRun({ ...request, dryRun: false }); }
			if (!capabilities || capabilities.success !== true || typeof capabilities.available !== 'boolean' || capabilities.backend !== 'bridge' || typeof capabilities.projectPath !== 'string'
				|| !sameProject(projectPath, capabilities.projectPath) || typeof capabilities.editorVersion !== 'string' || !/^\d+\.\d+\.\d+[abfp]\d+$/.test(capabilities.editorVersion)
				|| !Number.isSafeInteger(capabilities.editorPid) || Number(capabilities.editorPid) <= 0
				|| !Array.isArray(capabilities.modes) || capabilities.available && !capabilities.modes.includes(snapshot.mode)) {
				return fail('capability_unavailable', 'The bridge target or advertised test capabilities do not match this request.');
			}
			if (!capabilities.available) {
				if (requested === 'auto' && !list) { return await cliRun({ ...request, dryRun: false }); }
				return fail('test_framework_unavailable', 'The connected Editor does not advertise an available test runner.', 'Install Unity Test Framework in the target project, or select cli for a closed local project.');
			}
			snapshot.editorVersion = capabilities.editorVersion;
			if (!list && capabilities.supportsCancellation !== true) { return fail('test_cancel_unavailable', 'This Test Framework cannot cancel an owned test run.'); }
			context.reportProgress?.(0, 0, 'bridge ' + snapshot.editorVersion + ': selected');
			if (controller.signal.aborted) { return fail(expired ? 'timed_out' : 'cancelled', 'The test request ended before execution.'); }
			owner = { projectPath: capabilities.projectPath, editorPid: capabilities.editorPid, ownerToken: crypto.randomBytes(32).toString('hex'), runId: snapshot.runId, mode: snapshot.mode };
			let result = await interruptible(this.sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: list ? 'list' : 'run', ...owner, mode: snapshot.mode, filter: filters, timeoutMs } }));
			let lostSince: number | undefined;
			let lastCompleted = 0;
			while (true) {
				if (controller.signal.aborted) {
					return await stoppedError(expired ? 'timed_out' : 'cancelled', 'The owned test request was stopped.');
				}
				if (result == null) {
					lostSince ??= Date.now();
					if (Date.now() - lostSince >= 30000) { return await stoppedError('bridge_disconnected', 'The test bridge did not return after code reload.'); }
				} else {
					lostSince = undefined;
					const parsed = this.readSnapshot(result.result, snapshot, Number(owner.editorPid), projectPath);
					if (!parsed) { return await stoppedError('invalid_output', 'The test bridge returned an incomplete or inconsistent result.'); }
					if (terminal.has(parsed.status) && object(result.result)?.workStopped === false) { return await stoppedError('invalid_output', 'The bridge returned a terminal result while owned work is still pending.'); }
					Object.assign(snapshot, parsed);
					if (['error', 'cancelled', 'timed_out'].includes(snapshot.status)) { finished = true; return snapshot; }
					const completed = snapshot.summary.total - snapshot.summary.notRun;
					if (completed < lastCompleted) { return await stoppedError('invalid_output', 'The test bridge progress moved backwards.'); }
					lastCompleted = completed;
					context.reportProgress?.(completed, snapshot.summary.total, snapshot.backend + ' ' + snapshot.editorVersion + ': ' + snapshot.status);
					if (terminal.has(snapshot.status)) { finished = true; return snapshot; }
				}
				await new Promise<void>(resolve => {
					const done = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', done); resolve(); };
					const wait = setTimeout(done, 1000); controller.signal.addEventListener('abort', done, { once: true });
				});
				if (!controller.signal.aborted) { result = await interruptible(this.sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'status', ...owner } })); }
			}
		} catch { return await stoppedError('test_operation_failed', 'The test operation failed. No alternative backend was started.'); }
		finally { clearTimeout(timer); context.signal?.removeEventListener('abort', onAbort); this.active.delete(key); }
	}

	private readSnapshot(value: unknown, expected: UnityTestSnapshot, pid: number, projectPath: string): UnityTestSnapshot | undefined {
		const item = object(value), summary = object(item?.summary), error = object(item?.error);
		if (!item || item.backend !== 'bridge' || item.editorVersion !== expected.editorVersion || item.mode !== expected.mode || item.runId !== expected.runId
			|| item.editorPid !== pid || typeof item.success !== 'boolean' || !['discovering', 'listed', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'error'].includes(String(item.status))
			|| !Array.isArray(item.selection) || item.selection.length > 10000 || !item.selection.every(name => typeof name === 'string')
			|| !Array.isArray(item.tests) || item.tests.length > 10000 || !summary || Buffer.byteLength(JSON.stringify(item), 'utf8') > 1024 * 1024) { return undefined; }
		const tests: UnityTestCase[] = [];
		const counts = { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0 };
		const ids = new Set<string>(), names = new Set<string>();
		for (const raw of item.tests) {
			const test = object(raw);
			if (!test || typeof test.id !== 'string' || !test.id || ids.has(test.id) || typeof test.fullName !== 'string' || !test.fullName || names.has(test.fullName)
				|| !['passed', 'failed', 'skipped', 'inconclusive', 'not_run'].includes(String(test.status))
				|| typeof test.durationMs !== 'number' || !Number.isFinite(test.durationMs) || test.durationMs < 0
				|| typeof test.message !== 'string' || typeof test.stackTrace !== 'string') { return undefined; }
			ids.add(test.id); names.add(test.fullName);
			const leaf = test as unknown as UnityTestCase;
			const clean = (value: string) => redactUnityTestText(value, projectPath);
			tests.push({ id: clean(leaf.id), fullName: clean(leaf.fullName), status: leaf.status, durationMs: leaf.durationMs, message: clean(leaf.message), stackTrace: clean(leaf.stackTrace) });
			counts.total++; counts[leaf.status === 'not_run' ? 'notRun' : leaf.status]++;
		}
		const selection = (item.selection as string[]).map(name => redactUnityTestText(name, projectPath));
		const selected = new Set(selection);
		if (new Set(item.selection).size !== item.selection.length || new Set(tests.map(test => test.fullName)).size !== tests.length || new Set(tests.map(test => test.id)).size !== tests.length
			|| item.error !== undefined && !error
			|| ['failed', 'cancelled', 'timed_out', 'error'].includes(String(item.status)) && !error
			|| Object.keys(counts).some(key => summary[key] !== counts[key as keyof typeof counts])
			|| typeof summary.durationMs !== 'number' || !Number.isFinite(summary.durationMs) || summary.durationMs < 0
			|| item.selection.length !== tests.length || tests.some(test => !selected.has(test.fullName))
			|| ['listed', 'completed'].includes(String(item.status)) && item.success !== true
			|| ['failed', 'cancelled', 'timed_out', 'error'].includes(String(item.status)) && item.success !== false
			|| item.status === 'completed' && (counts.failed > 0 || counts.notRun > 0)
			|| item.status === 'failed' && counts.failed === 0
			|| error && (typeof error.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code) || redactUnityTestText(error.code, projectPath) !== error.code || typeof error.message !== 'string' || typeof error.recovery !== 'string')) { return undefined; }
		return { success: item.success, backend: 'bridge', runId: expected.runId, editorVersion: expected.editorVersion, mode: expected.mode,
			status: item.status as UnityTestSnapshot['status'], selection, tests,
			summary: { ...counts, durationMs: summary.durationMs }, ...(error ? { error: { code: error.code as string, message: redactUnityTestText(error.message as string, projectPath), recovery: redactUnityTestText(error.recovery as string, projectPath) } } : {}) };
	}
}
