/**
 * Batchmode launcher helpers for game_command host=editorBatchmode.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveProjectRoot } from './standaloneProjectTools';

const DEFAULT_TIMEOUT_MS = 120_000;
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

export async function runBatchmodeGameCommand(args: Record<string, unknown>): Promise<BatchmodeRunResult> {
	const timeoutMs = getNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS);
	const plan = await buildBatchmodeCommandPlan(args);

	return new Promise<BatchmodeRunResult>((resolve) => {
		const child = spawn(plan.unityPath, plan.args, { stdio: 'ignore' });
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
		}, timeoutMs);

		child.on('error', async (error) => {
			clearTimeout(timer);
			resolve({
				success: false,
				plan,
				exitCode: null,
				signal: null,
				error: error.message,
				logTail: await readLogTail(plan.logPath)
			});
		});

		child.on('exit', async (exitCode, signal) => {
			clearTimeout(timer);
			const result = await readJsonIfPresent(plan.resultPath);
			const timedOut = signal === 'SIGTERM' && exitCode == null;
			resolve({
				success: exitCode === 0 && timedOut === false && isFailureResult(result) === false,
				plan,
				exitCode,
				signal,
				result,
				error: timedOut ? `Unity batchmode command timed out after ${timeoutMs}ms.` : undefined,
				logTail: await readLogTail(plan.logPath)
			});
		});
	});
}

async function resolveUnityPath(projectPath: string, args: Record<string, unknown>): Promise<string> {
	const explicit = getString(args, 'unityPath', process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH ?? '');
	if (explicit.length > 0) {
		return explicit;
	}

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
