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

type SpawnUnityProcess = (command: string, args: readonly string[], options: { detached: true; stdio: 'ignore' }) => ChildProcess;

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
}

interface LaunchLockRecord {
	readonly schemaVersion: 1;
	readonly projectPath: string;
	readonly editorPath: string;
	readonly logPath: string;
	readonly startedAt: string;
	readonly updatedAt?: string;
	readonly pid?: number;
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

export function createUnityEditorLaunchPlan(projectPath: string, options: UnityEditorLaunchOptions = {}): UnityEditorLaunchPlan {
	const editorPath = resolveUnityEditorPath(projectPath, options);
	if (editorPath == null) {
		throw new Error('Unity Editor executable not found. Set unityCursorToolkit.unityEditorPath or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
	}

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
	acquireLaunchLock(plan, options);
	const spawnProcess = options.spawnProcess ?? spawn;
	let child: ChildProcess;
	try {
		child = spawnProcess(plan.editorPath, plan.args, { detached: true, stdio: 'ignore' });
	} catch (error: unknown) {
		releaseLaunchLock(plan, undefined);
		throw error;
	}
	updateLaunchLockPid(plan, child.pid);
	child.once('error', () => releaseLaunchLock(plan, child.pid));
	child.once('exit', () => releaseLaunchLock(plan, child.pid));
	child.unref();
	scheduleHideUnityEditor(child.pid, options.platform ?? process.platform);
	return { ...plan, pid: child.pid };
}

function acquireLaunchLock(plan: UnityEditorLaunchPlan, options: UnityEditorLaunchOptions): void {
	if (options.forceNewInstance !== true && fs.existsSync(plan.projectLockPath)) {
		throw new Error(`Unity project is already open or starting: ${plan.projectPath}. Not launching another hidden editor.`);
	}

	const record: LaunchLockRecord = {
		schemaVersion: 1,
		projectPath: plan.projectPath,
		editorPath: plan.editorPath,
		logPath: plan.logPath,
		startedAt: new Date().toISOString()
	};
	writeLaunchLock(plan.launchLockPath, record, options);
}

function writeLaunchLock(lockPath: string, record: LaunchLockRecord, options: UnityEditorLaunchOptions): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			try {
				fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
			} finally {
				fs.closeSync(fd);
			}
			return;
		} catch (error: unknown) {
			const code = typeof error === 'object' && error != null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
			if (code !== 'EEXIST') {
				throw error;
			}
			const existing = readLaunchLock(lockPath);
			if (isLaunchLockActive(lockPath, existing, options)) {
				const pidText = typeof existing?.pid === 'number' ? ` pid=${existing.pid}` : '';
				throw new Error(`Unity Editor launch already in progress for ${record.projectPath}.${pidText} Lock: ${lockPath}`);
			}
			fs.rmSync(lockPath, { force: true });
		}
	}

	throw new Error(`Unable to acquire Unity Editor launch lock: ${lockPath}`);
}

function updateLaunchLockPid(plan: UnityEditorLaunchPlan, pid: number | undefined): void {
	const existing = readLaunchLock(plan.launchLockPath);
	if (existing == null || existing.projectPath !== plan.projectPath) {
		return;
	}

	const next: LaunchLockRecord = {
		...existing,
		updatedAt: new Date().toISOString(),
		...(typeof pid === 'number' ? { pid } : {})
	};
	fs.writeFileSync(plan.launchLockPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function releaseLaunchLock(plan: UnityEditorLaunchPlan, pid: number | undefined): void {
	const existing = readLaunchLock(plan.launchLockPath);
	if (existing == null || existing.projectPath !== plan.projectPath) {
		return;
	}
	if (typeof pid === 'number' && typeof existing.pid === 'number' && existing.pid !== pid) {
		return;
	}
	fs.rmSync(plan.launchLockPath, { force: true });
}

function readLaunchLock(lockPath: string): LaunchLockRecord | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LaunchLockRecord>;
		if (parsed.schemaVersion !== 1 || typeof parsed.projectPath !== 'string' || typeof parsed.startedAt !== 'string') {
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

function scheduleHideUnityEditor(pid: number | undefined, platform: NodeJS.Platform): void {
	for (const delayMs of [5_000, 15_000, 30_000, 60_000]) {
		const timer = setTimeout(() => hideUnityEditor(pid, platform), delayMs);
		timer.unref?.();
	}
}

export function hideUnityEditor(pid?: number, platform: NodeJS.Platform = process.platform): void {
	if (platform === 'darwin') {
		const selector = pid == null
			? 'every process whose name contains "Unity"'
			: `every process whose unix id is ${pid}`;
		execFile('osascript', ['-e', `tell application "System Events" to set visible of ${selector} to false`], () => {});
		return;
	}

	if (platform === 'win32' && pid != null) {
		const script = [
			'$code = @"',
			'using System;',
			'using System.Runtime.InteropServices;',
			'public static class UCTShowWindow {',
			'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
			'}',
			'"@',
			'Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;',
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
			'if ($p -and $p.MainWindowHandle -ne 0) { [UCTShowWindow]::ShowWindowAsync($p.MainWindowHandle, 0) | Out-Null }'
		].join('\n');
		execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], () => {});
	}
}

function readProjectVersion(projectPath: string, options: UnityEditorLaunchOptions): string | null {
	try {
		const read = options.readFile ?? ((candidate: string) => fs.readFileSync(candidate, 'utf8'));
		const versionText = read(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'));
		const match = /^m_EditorVersion:\s*(.+)$/m.exec(versionText);
		return match == null ? null : match[1].trim();
	} catch {
		return null;
	}
}

function defaultUnityCandidates(version: string, platform: NodeJS.Platform): string[] {
	if (platform === 'darwin') {
		return [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`];
	}
	if (platform === 'win32') {
		return [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`];
	}
	return [`/opt/Unity/Hub/Editor/${version}/Editor/Unity`];
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
