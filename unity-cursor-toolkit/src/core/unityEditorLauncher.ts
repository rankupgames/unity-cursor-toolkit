/**
 * Unity Editor launcher for extension-owned hidden editor sessions.
 *
 * This starts the user's installed Unity Editor for the linked project. It does
 * not redistribute Unity, patch licensing, or load Unity assemblies out of
 * process; all rendering still happens inside the official editor binary.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

const DEFAULT_LAUNCH_LOCK_TTL_MS = 10 * 60 * 1000;
const PID_VISIBILITY_GRACE_MS = 30 * 1000;
const DEFAULT_HIDE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
const UNITY_EDITOR_VERSION_PATTERN = /^\d+\.\d+\.\d+[abcfp]\d+(?:[A-Za-z0-9._-]*)?$/i;
const scheduledHideTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const activeHideSessions = new Map<string, number>();

type SpawnUnityProcess = (command: string, args: readonly string[], options: { detached: true; stdio: 'ignore' }) => ChildProcess;
type HideUnityProcess = (pid: number, platform: NodeJS.Platform, launchId?: string) => Promise<boolean> | boolean;

export type UnityEditorLaunchErrorCode = 'editor-not-found' | 'project-locked' | 'handshake-failed' | 'launch-failed' | 'lock-failed' | 'license-failed';

export class UnityEditorLaunchError extends Error {
	public readonly code: UnityEditorLaunchErrorCode;
	public readonly cause?: unknown;

	public constructor(code: UnityEditorLaunchErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = 'UnityEditorLaunchError';
		this.code = code;
		this.cause = cause;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface UnityEditorLaunchOptions {
	readonly editorPathOverride?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly fileExists?: (candidate: string) => boolean;
	readonly readFile?: (candidate: string) => string;
	readonly tempDir?: string;
	readonly lockRoot?: string;
	readonly launchLockTtlMs?: number;
	readonly forceNewInstance?: boolean;
	readonly processExists?: (pid: number) => boolean;
	readonly spawnProcess?: SpawnUnityProcess;
	readonly hideProcess?: HideUnityProcess;
	readonly hideRetryDelaysMs?: readonly number[];
}

export interface UnityEditorSessionOptions extends UnityEditorLaunchOptions {
	readonly isToolkitResponsive?: () => Promise<boolean> | boolean;
}

export interface UnityEditorLaunchPlan {
	readonly editorPath: string;
	readonly projectPath: string;
	readonly args: readonly string[];
	readonly logPath: string;
	readonly launchLockPath: string;
	readonly projectLockPath: string;
}

export interface UnityEditorLaunchResult extends UnityEditorLaunchPlan {
	readonly pid: number | undefined;
	readonly reused: boolean;
	readonly sessionOwned: boolean;
	readonly launchId?: string;
	processError?: UnityEditorLaunchError;
	ownershipError?: UnityEditorLaunchError;
}

interface LaunchLockRecord {
	readonly schemaVersion: 1;
	readonly projectPath: string;
	readonly editorPath: string;
	readonly logPath: string;
	readonly startedAt: string;
	readonly updatedAt?: string;
	readonly pid?: number;
	readonly owner?: 'unity-cursor-toolkit';
	readonly sessionOwned?: boolean;
	readonly launchId?: string;
}

interface LaunchLockHandle {
	readonly lockPath: string;
	readonly launchId: string;
	readonly fd: number;
	closed: boolean;
}

export function resolveUnityEditorPath(projectPath: string, options: UnityEditorLaunchOptions = {}): string | null {
	const platform = options.platform ?? process.platform;
	const exists = options.fileExists ?? fs.existsSync;
	const env = options.env ?? process.env;
	const override = firstNonEmpty(options.editorPathOverride, env.UNITY_CURSOR_TOOLKIT_UNITY_PATH);

	for (const candidate of expandExecutableCandidates(override, platform)) {
		if (exists(candidate)) {
			return candidate;
		}
	}

	const version = readProjectVersion(projectPath, options);
	if (version == null) {
		return null;
	}

	for (const candidate of defaultUnityCandidates(version, platform)) {
		if (exists(candidate)) {
			return candidate;
		}
	}

	return null;
}

export function readUnityProjectVersion(projectPath: string): string | null {
	return readProjectVersion(projectPath, {});
}

export function matchesUnityProjectInfo(projectPath: string, expectedVersion: string | null, response: Record<string, unknown> | null): boolean {
	const result = response?.result;
	let projectInfo: Record<string, unknown> | null = null;
	if (typeof result === 'string') {
		try {
			const parsed = JSON.parse(result) as unknown;
			projectInfo = typeof parsed === 'object' && parsed != null ? parsed as Record<string, unknown> : null;
		} catch {
			return false;
		}
	} else if (typeof result === 'object' && result != null) {
		projectInfo = result as Record<string, unknown>;
	}

	const reportedProjectPath = projectInfo?.projectPath;
	if (typeof reportedProjectPath !== 'string' || normalizeUnityProjectPath(reportedProjectPath) !== normalizeUnityProjectPath(projectPath)) {
		return false;
	}

	if (expectedVersion == null) {
		return false;
	}
	return projectInfo?.unityVersion === expectedVersion;
}

function normalizeUnityProjectPath(projectPath: string): string {
	const normalized = path.normalize(projectPath);
	const withoutTrailingSeparator = normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
	return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

export function createUnityEditorLaunchPlan(projectPath: string, options: UnityEditorLaunchOptions = {}): UnityEditorLaunchPlan {
	const editorPath = resolveUnityEditorPath(projectPath, options);
	if (editorPath == null) {
		throw new UnityEditorLaunchError('editor-not-found', 'Unity Editor executable not found. Set unityCursorToolkit.unityEditorPath or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
	}
	return createUnityEditorLaunchPlanFromPath(projectPath, editorPath, options);
}

function createUnityEditorReusePlan(projectPath: string, options: UnityEditorSessionOptions): UnityEditorLaunchPlan {
	const env = options.env ?? process.env;
	const configuredEditorPath = firstNonEmpty(options.editorPathOverride, env.UNITY_CURSOR_TOOLKIT_UNITY_PATH);
	const editorPath = configuredEditorPath == null
		? ''
		: (expandExecutableCandidates(configuredEditorPath, options.platform ?? process.platform)[0] ?? configuredEditorPath);
	return createUnityEditorLaunchPlanFromPath(projectPath, editorPath, options);
}

function createUnityEditorLaunchPlanFromPath(projectPath: string, editorPath: string, options: UnityEditorLaunchOptions): UnityEditorLaunchPlan {
	const tempDir = options.tempDir ?? os.tmpdir();
	const logPath = path.join(tempDir, `unity-cursor-toolkit-hidden-editor-${safeName(path.basename(projectPath))}.log`);
	const lockRoot = options.lockRoot ?? tempDir;
	return {
		editorPath,
		projectPath,
		logPath,
		launchLockPath: path.join(lockRoot, `unity-cursor-toolkit-hidden-editor-${projectHash(projectPath)}.lock.json`),
		projectLockPath: path.join(projectPath, 'Temp', 'UnityLockfile'),
		args: [
			'-projectPath', projectPath,
			'-executeMethod', 'UnityCursorToolkit.HotReloadHandler.Start',
			'-silent-crashes',
			'-logFile', logPath
		]
	};
}

export function launchUnityEditor(projectPath: string, options: UnityEditorLaunchOptions = {}): UnityEditorLaunchResult {
	const plan = createUnityEditorLaunchPlan(projectPath, options);
	const lockHandle = acquireLaunchLock(plan, options);
	const launchId = lockHandle.launchId;
	const spawnProcess = options.spawnProcess ?? spawn;
	let child: ChildProcess;
	try {
		child = spawnProcess(plan.editorPath, plan.args, { detached: true, stdio: 'ignore' });
	} catch (error: unknown) {
		releaseLaunchLock(plan, undefined, lockHandle);
		if (error instanceof UnityEditorLaunchError) {
			throw error;
		}
		throw new UnityEditorLaunchError('launch-failed', `Failed to launch Unity Editor for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`, error);
	}
	const result: UnityEditorLaunchResult = { ...plan, pid: child.pid, reused: false, sessionOwned: true, launchId };
	if (typeof child.pid === 'number') {
		activeHideSessions.set(launchId, child.pid);
	}
	child.once('error', (error: Error) => {
		result.processError = new UnityEditorLaunchError(
			'launch-failed',
			`Unity Editor process failed for ${projectPath}: ${error.message}`,
			error
		);
		releaseLaunchLock(plan, child.pid, lockHandle);
	});
	child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
		if (result.processError == null) {
			result.processError = new UnityEditorLaunchError(
				'launch-failed',
				`Unity Editor process exited before the toolkit bridge was ready for ${projectPath}.${code == null ? '' : ` Exit code: ${code}.`}${signal == null ? '' : ` Signal: ${signal}.`}`
			);
		}
		releaseLaunchLock(plan, child.pid, lockHandle);
	});
	child.unref();
	scheduleHideUnityEditor(
		child.pid,
		options.platform ?? process.platform,
		options.hideProcess ?? hideUnityEditor,
		options.hideRetryDelaysMs ?? DEFAULT_HIDE_RETRY_DELAYS_MS,
		launchId
	);
	try {
		updateLaunchLockPid(plan, child.pid, lockHandle);
	} catch (error: unknown) {
		result.ownershipError = error instanceof UnityEditorLaunchError
			? error
			: new UnityEditorLaunchError(
				'lock-failed',
				`Unity Editor launched but its ownership lock could not be updated for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
	}
	return result;
}

export async function launchOrReuseUnityEditor(projectPath: string, options: UnityEditorSessionOptions = {}): Promise<UnityEditorLaunchResult> {
	const projectLockPath = path.join(projectPath, 'Temp', 'UnityLockfile');
	if (options.forceNewInstance !== true && fs.existsSync(projectLockPath)) {
		if (options.isToolkitResponsive == null) {
			throw new UnityEditorLaunchError(
				'project-locked',
				`Unity project is already open: ${projectPath}. A responsive toolkit handshake is required before reusing it.`
			);
		}

		let responsive = false;
		try {
			responsive = await options.isToolkitResponsive();
		} catch (error: unknown) {
			throw new UnityEditorLaunchError(
				'handshake-failed',
				`Unity project is already open: ${projectPath}. Toolkit handshake failed, so another editor will not be launched: ${error instanceof Error ? error.message : String(error)}`,
				error
			);
		}

		if (responsive) {
			const plan = createUnityEditorReusePlan(projectPath, options);
			return { ...plan, pid: undefined, reused: true, sessionOwned: false };
		}

		throw new UnityEditorLaunchError(
			'project-locked',
			`Unity project is already open: ${projectPath}. Toolkit handshake did not respond, so another hidden editor will not be launched. If no Unity Editor has this project open, confirm that first, then remove the stale Temp/UnityLockfile and retry.`
		);
	}

	return launchUnityEditor(projectPath, options);
}

function acquireLaunchLock(plan: UnityEditorLaunchPlan, options: UnityEditorLaunchOptions): LaunchLockHandle {
	if (options.forceNewInstance !== true && fs.existsSync(plan.projectLockPath)) {
		throw new UnityEditorLaunchError('project-locked', `Unity project is already open or starting: ${plan.projectPath}. Not launching another hidden editor.`);
	}

	const launchId = crypto.randomBytes(16).toString('hex');
	const record: LaunchLockRecord = {
		schemaVersion: 1,
		projectPath: plan.projectPath,
		editorPath: plan.editorPath,
		logPath: plan.logPath,
		startedAt: new Date().toISOString(),
		owner: 'unity-cursor-toolkit',
		sessionOwned: true,
		launchId
	};
	try {
		const fd = writeLaunchLock(plan.launchLockPath, record, options);
		return { lockPath: plan.launchLockPath, launchId, fd, closed: false };
	} catch (error: unknown) {
		if (error instanceof UnityEditorLaunchError) {
			throw error;
		}
		throw new UnityEditorLaunchError(
			'lock-failed',
			`Unable to acquire Unity Editor launch lock for ${plan.projectPath}: ${error instanceof Error ? error.message : String(error)}`,
			error
		);
	}
}

function writeLaunchLock(lockPath: string, record: LaunchLockRecord, options: UnityEditorLaunchOptions): number {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number | undefined;
		try {
			fd = fs.openSync(lockPath, 'wx+');
			fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
			return fd;
		} catch (error: unknown) {
			if (fd != null) {
				try {
					fs.closeSync(fd);
				} catch {
					// Preserve the original acquisition error.
				}
			}
			const code = typeof error === 'object' && error != null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
			if (code !== 'EEXIST') {
				throw error;
			}
			const existing = readLaunchLock(lockPath);
			if (isLaunchLockActive(lockPath, existing, options)) {
				const pidText = typeof existing?.pid === 'number' ? ` pid=${existing.pid}` : '';
				throw new UnityEditorLaunchError('project-locked', `Unity Editor launch already in progress for ${record.projectPath}.${pidText} Lock: ${lockPath}`);
			}
			quarantineStaleLaunchLock(lockPath);
		}
	}

	throw new UnityEditorLaunchError('project-locked', `Unable to acquire Unity Editor launch lock: ${lockPath}`);
}

function quarantineStaleLaunchLock(lockPath: string): void {
	const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
	try {
		fs.renameSync(lockPath, quarantinePath);
	} catch (error: unknown) {
		const code = typeof error === 'object' && error != null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
		if (code === 'ENOENT') {
			return;
		}
		throw error;
	}
	fs.rmSync(quarantinePath, { recursive: true, force: true });
}

function updateLaunchLockPid(plan: UnityEditorLaunchPlan, pid: number | undefined, lockHandle: LaunchLockHandle): void {
	if (!sameLockFile(plan.launchLockPath, lockHandle.fd)) {
		throw new UnityEditorLaunchError('lock-failed', `Unity Editor ownership lock was replaced during launch: ${plan.launchLockPath}`);
	}
	const existing = readLaunchLockFromFd(lockHandle.fd);
	if (existing == null) {
		throw new UnityEditorLaunchError('lock-failed', `Unity Editor ownership lock disappeared after launch: ${plan.launchLockPath}`);
	}
	if (existing.projectPath !== plan.projectPath) {
		throw new UnityEditorLaunchError('lock-failed', `Unity Editor ownership lock points to another project: ${plan.launchLockPath}`);
	}
	if (existing.launchId !== lockHandle.launchId || existing.owner !== 'unity-cursor-toolkit' || existing.sessionOwned !== true) {
		throw new UnityEditorLaunchError('lock-failed', `Unity Editor ownership lock belongs to another launch session: ${plan.launchLockPath}`);
	}

	const next: LaunchLockRecord = {
		...existing,
		updatedAt: new Date().toISOString(),
		...(typeof pid === 'number' ? { pid } : {})
	};
	try {
		writeLaunchLockRecord(lockHandle.fd, next);
		if (!sameLockFile(plan.launchLockPath, lockHandle.fd)) {
			throw new UnityEditorLaunchError('lock-failed', `Unity Editor ownership lock was replaced during its process update: ${plan.launchLockPath}`);
		}
	} catch (error: unknown) {
		if (error instanceof UnityEditorLaunchError) {
			throw error;
		}
		throw new UnityEditorLaunchError(
			'lock-failed',
			`Unable to record the Unity Editor process ownership lock for ${plan.projectPath}: ${error instanceof Error ? error.message : String(error)}`,
			error
		);
	}
}

function releaseLaunchLock(plan: UnityEditorLaunchPlan, pid: number | undefined, lockHandle: LaunchLockHandle): void {
	try {
		cancelScheduledHide(lockHandle.launchId);
		activeHideSessions.delete(lockHandle.launchId);
		const existing = readLaunchLockFromFd(lockHandle.fd);
		if (!sameLockFile(plan.launchLockPath, lockHandle.fd) || existing == null) {
			return;
		}
		if (existing.projectPath !== plan.projectPath || existing.launchId !== lockHandle.launchId || existing.owner !== 'unity-cursor-toolkit' || existing.sessionOwned !== true) {
			return;
		}
		if (typeof pid === 'number' && typeof existing.pid === 'number' && existing.pid !== pid) {
			return;
		}
		removeOwnedLaunchLock(lockHandle);
	} catch (error: unknown) {
		// Child process callbacks must not turn a best-effort cleanup failure into an
		// uncaught exception that can crash the extension host.
		console.warn(`[UnityEditorLauncher] Unable to release launch lock ${lockHandle.lockPath}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		closeLaunchLockHandle(lockHandle);
	}
}

function writeLaunchLockRecord(fd: number, record: LaunchLockRecord): void {
	const contents = Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8');
	let offset = 0;
	while (offset < contents.length) {
		const written = fs.writeSync(fd, contents, offset, contents.length - offset, offset);
		if (written <= 0) {
			throw new Error('Unable to write the Unity Editor ownership lock');
		}
		offset += written;
	}
	fs.ftruncateSync(fd, contents.length);
}

function sameLockFile(lockPath: string, fd: number): boolean {
	try {
		const pathStats = fs.statSync(lockPath);
		const fdStats = fs.fstatSync(fd);
		return pathStats.dev === fdStats.dev && pathStats.ino === fdStats.ino;
	} catch {
		return false;
	}
}

function removeOwnedLaunchLock(lockHandle: LaunchLockHandle): void {
	const quarantinePath = `${lockHandle.lockPath}.release-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
	try {
		fs.renameSync(lockHandle.lockPath, quarantinePath);
	} catch (error: unknown) {
		const code = typeof error === 'object' && error != null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
		if (code !== 'ENOENT') {
			console.warn(`[UnityEditorLauncher] Unable to quarantine launch lock ${lockHandle.lockPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}

	const movedRecord = readLaunchLock(quarantinePath);
	if (movedRecord?.launchId === lockHandle.launchId && sameLockFile(quarantinePath, lockHandle.fd)) {
		fs.rmSync(quarantinePath, { recursive: true, force: true });
		return;
	}

	try {
		if (!fs.existsSync(lockHandle.lockPath)) {
			fs.renameSync(quarantinePath, lockHandle.lockPath);
		} else {
			console.warn(`[UnityEditorLauncher] Preserved a replacement launch lock while releasing ${lockHandle.lockPath}`);
		}
	} catch (error: unknown) {
		console.warn(`[UnityEditorLauncher] Unable to restore a replacement launch lock ${lockHandle.lockPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function closeLaunchLockHandle(lockHandle: LaunchLockHandle): void {
	if (lockHandle.closed) {
		return;
	}
	lockHandle.closed = true;
	try {
		fs.closeSync(lockHandle.fd);
	} catch {
		// The process is already losing ownership; there is no safe cleanup action left.
	}
}

function readLaunchLock(lockPath: string): LaunchLockRecord | null {
	try {
		return parseLaunchLock(fs.readFileSync(lockPath, 'utf8'));
	} catch {
		return null;
	}
}

function readLaunchLockFromFd(fd: number): LaunchLockRecord | null {
	try {
		const stats = fs.fstatSync(fd);
		const contents = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < contents.length) {
			const read = fs.readSync(fd, contents, offset, contents.length - offset, offset);
			if (read <= 0) {
				return null;
			}
			offset += read;
		}
		return parseLaunchLock(contents.toString('utf8'));
	} catch {
		return null;
	}
}

function parseLaunchLock(contents: string): LaunchLockRecord | null {
	try {
		const parsed = JSON.parse(contents) as Partial<LaunchLockRecord>;
		if (parsed.schemaVersion !== 1 || typeof parsed.projectPath !== 'string' || typeof parsed.startedAt !== 'string') {
			return null;
		}
		if (parsed.launchId != null && (typeof parsed.launchId !== 'string' || parsed.launchId.length === 0)) {
			return null;
		}
		return parsed as LaunchLockRecord;
	} catch {
		return null;
	}
}

function isLaunchLockActive(lockPath: string, record: LaunchLockRecord | null, options: UnityEditorLaunchOptions): boolean {
	const ageMs = launchLockAgeMs(lockPath, record);
	const ttlMs = options.launchLockTtlMs ?? DEFAULT_LAUNCH_LOCK_TTL_MS;
	if (ageMs > ttlMs) {
		return false;
	}

	if (typeof record?.pid !== 'number') {
		return true;
	}

	const exists = options.processExists ?? defaultProcessExists;
	return exists(record.pid) || ageMs < PID_VISIBILITY_GRACE_MS;
}

function launchLockAgeMs(lockPath: string, record: LaunchLockRecord | null): number {
	const startedAt = record == null ? Number.NaN : Date.parse(record.updatedAt ?? record.startedAt);
	if (Number.isFinite(startedAt)) {
		return Math.max(0, Date.now() - startedAt);
	}

	try {
		return Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function defaultProcessExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		const code = typeof error === 'object' && error != null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
		return code === 'EPERM';
	}
}

function scheduleHideUnityEditor(
	pid: number | undefined,
	platform: NodeJS.Platform,
	hideProcess: HideUnityProcess,
	retryDelaysMs: readonly number[],
	launchId: string
): void {
	if (pid == null) {
		return;
	}
	activeHideSessions.set(launchId, pid);
	cancelScheduledHide(launchId);
	if (retryDelaysMs.length === 0) {
		return;
	}

	const timers: ReturnType<typeof setTimeout>[] = [];
	scheduledHideTimers.set(launchId, timers);
	for (const delayMs of retryDelaysMs) {
		const timer = setTimeout(() => {
			removeScheduledHideTimer(launchId, timer);
			void Promise.resolve().then(() => {
				if (activeHideSessions.get(launchId) !== pid) {
					return false;
				}
				return hideProcess(pid, platform, launchId);
			}).then((success) => {
				if (success && activeHideSessions.get(launchId) === pid) {
					cancelScheduledHide(launchId);
				}
			}).catch(() => {
				// Hiding is best-effort. The remaining scheduled attempts may still succeed.
			});
		}, Math.max(0, delayMs));
		timer.unref?.();
		timers.push(timer);
	}
}

function removeScheduledHideTimer(launchId: string, timer: ReturnType<typeof setTimeout>): void {
	const timers = scheduledHideTimers.get(launchId);
	if (timers == null) {
		return;
	}
	const index = timers.indexOf(timer);
	if (index >= 0) {
		timers.splice(index, 1);
	}
	if (timers.length === 0) {
		scheduledHideTimers.delete(launchId);
	}
}

function cancelScheduledHide(launchId: string): void {
	const timers = scheduledHideTimers.get(launchId);
	if (timers == null) {
		return;
	}
	for (const timer of timers) {
		clearTimeout(timer);
	}
	scheduledHideTimers.delete(launchId);
}

export async function hideUnityEditor(pid?: number, platform: NodeJS.Platform = process.platform, launchId?: string): Promise<boolean> {
	if (pid == null || !Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	if (launchId != null && activeHideSessions.get(launchId) !== pid) {
		return false;
	}

	let hidden = false;
	try {
		hidden = await executeHideUnityEditor(pid, platform);
	} catch {
		return false;
	}
	if (hidden) {
		if (launchId != null) {
			cancelScheduledHide(launchId);
		}
	}
	return hidden;
}

function executeHideUnityEditor(pid: number, platform: NodeJS.Platform): Promise<boolean> {
	if (platform === 'darwin') {
		const selector = `every process whose unix id is ${pid}`;
		return runHideCommand('osascript', ['-e', `tell application "System Events" to set visible of ${selector} to false`]);
	}

	if (platform === 'win32') {
		const script = [
			'$ErrorActionPreference = "Stop";',
			'$code = @"',
			'using System;',
			'using System.Runtime.InteropServices;',
			'public static class UCTShowWindow {',
			'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
			'  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
			'}',
			'"@',
			'try {',
			'  Add-Type -TypeDefinition $code -ErrorAction Stop;',
			`  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
			'  if (-not $p -or $p.MainWindowHandle -eq 0) { exit 1 }',
			'  # ShowWindowAsync returns prior visibility; verify the final state instead.',
			'  [UCTShowWindow]::ShowWindowAsync($p.MainWindowHandle, 0) | Out-Null;',
			'  Start-Sleep -Milliseconds 100;',
			'  if ([UCTShowWindow]::IsWindowVisible($p.MainWindowHandle)) { exit 1 }',
			'  exit 0',
			'} catch {',
			'  exit 1',
			'}'
		].join('\n');
		return runHideCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
	}

	return Promise.resolve(false);
}

function runHideCommand(command: string, args: readonly string[]): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, (error) => resolve(error == null));
	});
}

export function readUnityEditorLaunchFailure(logPath: string): UnityEditorLaunchError | null {
	let contents: string;
	try {
		contents = fs.readFileSync(logPath, 'utf8');
	} catch {
		return null;
	}

	const licenseFailure = contents.split(/\r?\n/).find(line =>
		/\b(?:license|licence|entitlement|serial(?: number)?|activation)\b/i.test(line) &&
		/\b(?:failed|failure|invalid|expired|missing|unable|cannot|could not|not valid|not found|no valid|error)\b/i.test(line)
	);
	if (licenseFailure == null) {
		return null;
	}

	return new UnityEditorLaunchError(
		'license-failed',
		`Unity Editor license activation failed. Inspect the Unity log: ${logPath}`
	);
}

function readProjectVersion(projectPath: string, options: UnityEditorLaunchOptions): string | null {
	try {
		const read = options.readFile ?? ((candidate: string) => fs.readFileSync(candidate, 'utf8'));
		const versionText = read(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'));
		const match = /^m_EditorVersion:\s*(.+)$/m.exec(versionText);
		const version = match == null ? null : match[1].trim();
		return version != null && UNITY_EDITOR_VERSION_PATTERN.test(version) ? version : null;
	} catch {
		return null;
	}
}

function defaultUnityCandidates(version: string, platform: NodeJS.Platform): string[] {
	if (!UNITY_EDITOR_VERSION_PATTERN.test(version)) {
		return [];
	}

	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	if (platform === 'darwin') {
		return boundedUnityCandidate('/Applications/Unity/Hub/Editor', version, ['Unity.app', 'Contents', 'MacOS', 'Unity'], pathApi);
	}
	if (platform === 'win32') {
		return boundedUnityCandidate('C:\\Program Files\\Unity\\Hub\\Editor', version, ['Editor', 'Unity.exe'], pathApi);
	}
	return boundedUnityCandidate('/opt/Unity/Hub/Editor', version, ['Editor', 'Unity'], pathApi);
}

function boundedUnityCandidate(root: string, version: string, suffix: string[], pathApi: typeof path.posix): string[] {
	const candidate = pathApi.join(root, version, ...suffix);
	const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
	if (relative === '' || relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
		return [];
	}
	return [candidate];
}

function expandExecutableCandidates(candidate: string | undefined, platform: NodeJS.Platform): string[] {
	if (candidate == null || candidate.trim().length === 0) {
		return [];
	}

	const trimmed = candidate.trim();
	if (platform === 'darwin' && trimmed.endsWith('.app')) {
		return [path.join(trimmed, 'Contents', 'MacOS', 'Unity'), trimmed];
	}
	if (platform === 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity.exe'), trimmed];
	}
	if (platform !== 'darwin' && platform !== 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity'), trimmed];
	}
	return [trimmed];
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value != null && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function safeName(value: string): string {
	return value.replace(/[^a-z0-9_.-]+/gi, '_') || 'project';
}

function projectHash(projectPath: string): string {
	return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
}
