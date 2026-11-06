/**
 * Targeted focus for the one running Unity Editor that owns a project.
 *
 * Focus can resume Editor work deferred while it is in the background. This helper activates the
 * exact owning process. It never launches, kills, hides, or saves an Editor or project.
 *
 * Builtin imports only: Node can run it directly (see scripts/focus-unity-editor.js) without a build.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

const COMMAND_TIMEOUT_MS = 3_000;
const UNITY_EDITOR_VERSION_PATTERN = /^\d+\.\d+\.\d+[abcfp]\d+(?:[A-Za-z0-9._-]*)?$/i;
const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const OSASCRIPT = '/usr/bin/osascript';
// System Events addresses the existing process by Unix PID; no Unity app is opened or launched.
const ACTIVATE_SCRIPT = `on run argv
	set targetPid to (item 1 of argv) as integer
	tell application "System Events"
		set targetProcess to first application process whose unix id is targetPid
		set frontmost of targetProcess to true
	end tell
	return "requested"
end run`;
const VERIFY_SCRIPT = `function run(argv) {
	ObjC.import('AppKit');
	const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
	if (app.js === undefined || app.terminated) { return 'missing'; }
	for (let attempt = 0; attempt < 3 && !app.active; attempt++) { delay(0.2); }
	return app.active ? 'activated' : 'background';
}`;

export type UnityEditorFocusState = 'activated' | 'not_running' | 'ambiguous' | 'mismatch' | 'not_foreground' | 'permission_denied' | 'failed' | 'unsupported';

export interface UnityEditorFocusResult {
	readonly state: UnityEditorFocusState;
	readonly pid?: number;
	readonly reason: string;
}

export interface UnityEditorFocusRequest {
	readonly projectRoot: string;
	/** Process id the bridge reported for this Editor, when known. Must equal the lock owner. */
	readonly expectedPid?: number;
}

export interface UnityEditorCommandResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly timedOut: boolean;
	readonly nativeErrorCode?: number;
}

export type UnityEditorRunCommand = (command: string, args: readonly string[], timeoutMs: number) => Promise<UnityEditorCommandResult>;

export interface UnityEditorFocusDependencies {
	readonly platform?: NodeJS.Platform;
	readonly run?: UnityEditorRunCommand;
	readonly readFile?: (candidate: string) => string;
	readonly env?: NodeJS.ProcessEnv;
}

export type UnityEditorFocus = (request: UnityEditorFocusRequest) => Promise<UnityEditorFocusResult>;

/** macOS only. Other platforms return an explicit unsupported result instead of guessing. */
export async function focusUnityEditor(request: UnityEditorFocusRequest, dependencies: UnityEditorFocusDependencies = {}): Promise<UnityEditorFocusResult> {
	const platform = dependencies.platform ?? process.platform;
	if (platform !== 'darwin') {
		return { state: 'unsupported', reason: `Targeted Editor focus supports macOS only, not ${platform}.` };
	}
	const run = dependencies.run ?? runCommand;
	const projectRoot = path.resolve(request.projectRoot);
	const env = dependencies.env ?? process.env;

	const first = await findLockOwner(projectRoot, run);
	if (typeof first !== 'number') { return first; }
	if (request.expectedPid != null && request.expectedPid !== first) {
		return { state: 'mismatch', pid: first, reason: 'The project lock owner is not the Editor process the bridge reported.' };
	}
	const executable = await readExecutable(first, run);
	if (typeof executable !== 'string') { return executable; }
	const version = readEditorVersion(projectRoot, dependencies.readFile);
	if (version == null) {
		return { state: 'mismatch', pid: first, reason: 'The project Editor version is missing or invalid. Focus was not requested.' };
	}
	if (!executableMatches(executable, version, env.UNITY_CURSOR_TOOLKIT_UNITY_PATH)) {
		return { state: 'mismatch', pid: first, reason: 'The lock owner is not the Unity Editor installed for this project version.' };
	}

	// Revalidate right before activation so a pid reused or handed over since the first check is never focused.
	const second = await findLockOwner(projectRoot, run);
	if (typeof second !== 'number') { return second; }
	if (second !== first) {
		return { state: 'mismatch', pid: second, reason: 'The project lock owner changed while focus was being prepared.' };
	}

	const activation = await run(OSASCRIPT, ['-e', ACTIVATE_SCRIPT, String(first)], COMMAND_TIMEOUT_MS);
	if (activation.nativeErrorCode === -1743) {
		return { state: 'permission_denied', pid: first, reason: 'macOS denied permission to activate this Editor through System Events.' };
	}
	if (activation.timedOut || activation.code !== 0 || activation.stdout.trim() !== 'requested') {
		return { state: 'failed', pid: first, reason: activation.timedOut ? 'Activation timed out.' : 'Activation command failed.' };
	}
	const verification = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', VERIFY_SCRIPT, String(first)], COMMAND_TIMEOUT_MS);
	if (verification.timedOut || verification.code !== 0) {
		return { state: 'failed', pid: first, reason: 'The Editor foreground state could not be verified.' };
	}
	const outcome = verification.stdout.trim();
	if (outcome === 'activated') {
		return { state: 'activated', pid: first, reason: 'The project owner is the active application. This does not prove compilation or main-thread recovery.' };
	}
	if (outcome === 'background') {
		return { state: 'not_foreground', pid: first, reason: 'macOS accepted the request but the Editor stayed in the background.' };
	}
	return { state: outcome === 'missing' ? 'not_running' : 'failed', pid: first, reason: outcome === 'missing' ? 'The Editor process exited before activation.' : 'macOS returned an unexpected foreground state.' };
}

async function findLockOwner(projectRoot: string, run: UnityEditorRunCommand): Promise<number | UnityEditorFocusResult> {
	const result = await run(LSOF, ['-t', path.join(projectRoot, 'Temp', 'UnityLockfile')], COMMAND_TIMEOUT_MS);
	if (result.timedOut || (result.code !== 0 && result.code !== 1)) {
		return { state: 'failed', reason: 'Project lock ownership could not be read.' };
	}
	const lines = result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
	if (lines.some(line => !/^\d+$/.test(line))) {
		return { state: 'failed', reason: 'Project lock ownership returned unexpected output.' };
	}
	const owners = [...new Set(lines.map(Number))].filter(pid => pid > 0);
	if (owners.length === 0) { return { state: 'not_running', reason: 'No running Editor holds this project lock.' }; }
	if (owners.length > 1) { return { state: 'ambiguous', reason: 'More than one process holds this project lock.' }; }
	return owners[0];
}

/** `comm=` prints only the executable path, never the arguments. */
async function readExecutable(pid: number, run: UnityEditorRunCommand): Promise<string | UnityEditorFocusResult> {
	const result = await run(PS, ['-p', String(pid), '-o', 'comm='], COMMAND_TIMEOUT_MS);
	if (result.timedOut || result.code !== 0) {
		return { state: 'not_running', pid, reason: 'The lock owner process is no longer running.' };
	}
	return result.stdout.trim();
}

function readEditorVersion(projectRoot: string, readFile: (candidate: string) => string = candidate => fs.readFileSync(candidate, 'utf8')): string | null {
	try {
		const match = /^m_EditorVersion:\s*(.+)$/m.exec(readFile(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt')));
		const version = match == null ? null : match[1].trim();
		return version != null && UNITY_EDITOR_VERSION_PATTERN.test(version) ? version : null;
	} catch {
		return null;
	}
}

function executableMatches(executable: string, version: string | null, override: string | undefined): boolean {
	if (!path.isAbsolute(executable)) { return false; }
	if (override != null && override.trim().length > 0) {
		const trimmed = override.trim();
		if (path.resolve(trimmed.endsWith('.app') ? path.join(trimmed, 'Contents', 'MacOS', 'Unity') : trimmed) === path.resolve(executable)) { return true; }
	}
	return version != null && executable.endsWith(`/${version}/Unity.app/Contents/MacOS/Unity`);
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<UnityEditorCommandResult> {
	return new Promise(resolve => {
		execFile(command, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
			resolve({
				code: failure == null ? 0 : typeof failure.code === 'number' ? failure.code : null,
				stdout: String(stdout),
				timedOut: failure?.killed === true,
				nativeErrorCode: /\(-1743\)/.test(String(stderr)) ? -1743 : undefined
			});
		});
	});
}
