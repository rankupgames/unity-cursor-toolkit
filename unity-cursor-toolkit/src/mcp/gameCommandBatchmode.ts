/**
 * Batchmode launcher helpers for game_command host=editorBatchmode.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { terminateOwnedProcessTree } from '../core/unityCliAdapter';
import { resolveProjectRoot } from './standaloneProjectTools';

const DEFAULT_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const ENTRY_METHOD = 'UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run';

export interface BatchmodeCommandPlan {
	readonly unityPath: string;
	readonly projectPath: string;
	readonly method: string;
	readonly args: string[];
	readonly command: string[];
	readonly resultPath: string;
	readonly logPath: string;
	readonly argsPath: string;
}

export interface BatchmodeRunResult {
	readonly success: boolean;
	readonly plan: BatchmodeCommandPlan;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly result?: unknown;
	readonly terminationReason?: 'timed_out' | 'cancelled';
	readonly logTail?: string;
	readonly error?: string;
}

export function shouldUseEditorBatchmode(args: Record<string, unknown>): boolean {
	const host = typeof args.host === 'string' ? args.host : '';
	return host === 'editorBatchmode';
}

export async function buildBatchmodeCommandPlan(args: Record<string, unknown>): Promise<BatchmodeCommandPlan> {
	const projectPath = resolveProjectRoot();
	const unityPath = await resolveUnityPath(projectPath, args);
	const action = getString(args, 'action', 'list');
	const commandName = getString(args, 'commandName', getString(args, 'name', ''));
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'uct-batch-'));
	const resultPath = path.join(tempRoot, 'result.json');
	const logPath = path.join(tempRoot, 'unity.log');
	const argsPath = path.join(tempRoot, 'args.json');
	const commandArgs = args.args && typeof args.args === 'object' ? args.args : {};

	await fs.writeFile(argsPath, JSON.stringify(commandArgs), 'utf8');

	const cliArgs = [
		'-batchmode',
		'-quit',
		'-projectPath', projectPath,
		'-executeMethod', ENTRY_METHOD,
		'-logFile', logPath,
		'-uctCommandAction', action,
		'-uctCommandArgsPath', argsPath,
		'-uctCommandResultPath', resultPath
	];

	if (commandName.length > 0) {
		cliArgs.push('-uctCommandName', commandName);
	}

	return {
		unityPath,
		projectPath,
		method: ENTRY_METHOD,
		args: cliArgs,
		command: [unityPath, ...cliArgs],
		resultPath,
		logPath,
		argsPath
	};
}

export async function runBatchmodeGameCommand(args: Record<string, unknown>, signal?: AbortSignal): Promise<BatchmodeRunResult> {
	const plan = await buildBatchmodeCommandPlan(args);
	return executeBatchmodePlan(plan, getNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS), signal);
}

/** Runs the planned child, stops only its owned process tree on timeout or abort, and resolves after it closes. */
export function executeBatchmodePlan(plan: BatchmodeCommandPlan, timeoutMs: number, abortSignal?: AbortSignal): Promise<BatchmodeRunResult> {
	if (abortSignal?.aborted) {
		return Promise.resolve({ success: false, plan, exitCode: null, signal: null, terminationReason: 'cancelled', error: 'Unity batchmode command was cancelled before it started.' });
	}

	return new Promise<BatchmodeRunResult>((resolve) => {
		let finished = false;
		let exited = false;
		let stopReason: 'timed_out' | 'cancelled' | undefined;
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(plan.unityPath, plan.args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });

		const finish = async (exitCode: number | null, exitSignal: NodeJS.Signals | null, failure?: string): Promise<void> => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timeoutTimer);
			clearTimeout(cleanupTimer);
			abortSignal?.removeEventListener('abort', cancel);
			const result = await readJsonIfPresent(plan.resultPath);
			const stopped = stopReason === 'timed_out'
				? `Unity batchmode command timed out after ${timeoutMs}ms; its owned process tree was terminated.`
				: stopReason === 'cancelled' ? 'Unity batchmode command was cancelled; its owned process tree was terminated.' : undefined;
			resolve({
				success: failure == null && stopReason == null && exitCode === 0 && isFailureResult(result) === false,
				plan,
				exitCode,
				signal: exitSignal,
				result,
				terminationReason: stopReason,
				error: failure ?? stopped,
				logTail: await readLogTail(plan.logPath)
			});
		};

		const stop = async (reason: 'timed_out' | 'cancelled'): Promise<void> => {
			if (finished || stopReason != null) {
				return;
			}
			stopReason = reason;
			const delivered = exited || (child.pid != null && await terminateOwnedProcessTree(child.pid, process.env));
			cleanupTimer = setTimeout(() => {
				void finish(null, null, `Unity batchmode command ${reason}; owned-process termination could not be confirmed.`);
			}, delivered ? CLEANUP_TIMEOUT_MS : 0);
		};

		const cancel = (): void => { void stop('cancelled'); };
		const timeoutTimer = setTimeout(() => { void stop('timed_out'); }, timeoutMs);
		abortSignal?.addEventListener('abort', cancel, { once: true });
		child.once('error', (error) => { void finish(null, null, error.message); });
		child.once('exit', () => { exited = true; });
		child.once('close', (exitCode, exitSignal) => { void finish(exitCode, exitSignal); });
	});
}

async function resolveUnityPath(projectPath: string, args: Record<string, unknown>): Promise<string> {
	const explicit = getString(args, 'unityPath', process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH ?? '');
	if (explicit.length > 0) {
		return explicit;
	}

	// ProjectVersion selects the installed batchmode Editor executable, not runtime feature behavior.
	const version = await readUnityProjectVersion(projectPath);
	const candidates = version ? unityPathCandidates(version) : [];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Try next candidate.
		}
	}

	throw new Error('Unity executable not found. Pass unityPath or set UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
}

async function readUnityProjectVersion(projectPath: string): Promise<string | null> {
	try {
		const content = await fs.readFile(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
		return /^m_EditorVersion:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

function unityPathCandidates(version: string): string[] {
	if (process.platform === 'darwin') {
		return [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`];
	}
	if (process.platform === 'win32') {
		return [
			`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`,
			`C:\\Program Files\\Unity\\Editor\\Unity.exe`
		];
	}
	return [
		`/opt/Unity/Hub/Editor/${version}/Editor/Unity`,
		`/opt/unity/Editor/Unity`
	];
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8'));
	} catch {
		return undefined;
	}
}

async function readLogTail(filePath: string): Promise<string | undefined> {
	try {
		const text = await fs.readFile(filePath, 'utf8');
		return text.split(/\r?\n/).slice(-80).join('\n');
	} catch {
		return undefined;
	}
}

function isFailureResult(result: unknown): boolean {
	return typeof result === 'object'
		&& result != null
		&& (result as { success?: unknown }).success === false;
}

function getString(args: Record<string, unknown>, key: string, fallback: string): string {
	const value = args[key];
	return typeof value === 'string' ? value : fallback;
}

function getNumber(args: Record<string, unknown>, key: string, fallback: number): number {
	const value = args[key];
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
