#!/usr/bin/env node

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { createExampleManifest, loadRemoteShellManifest, resolveManifestPath } from './manifest';
import { CommandPlan, RemoteShellPlan, createRemoteShellPlan } from './sidecarPlan';
import { withSessionLifecycle, type UnityHostSessionSnapshot } from './session';

interface CliOptions {
	readonly action: string;
	readonly manifestPath: string;
	readonly workspaceRoot: string;
	readonly extensionRoot: string;
	readonly localPortBase?: number;
	readonly shellAppPath?: string;
}

interface SessionState {
	readonly manifestPath: string;
	readonly statePath: string;
	readonly startedAt: string;
	readonly links: RemoteShellPlan['links'];
	readonly session: UnityHostSessionSnapshot;
	readonly pids: {
		readonly sshTunnel?: number;
		readonly remoteStart?: number;
		readonly shell?: number;
	};
}

export async function runCli(argv: string[], io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process): Promise<number> {
	try {
		const options = parseCliOptions(argv);
		switch (options.action) {
			case 'init':
				await initManifest(options);
				return 0;
			case 'plan':
				await printPlan(options, io.stdout);
				return 0;
			case 'launch':
				await launch(options, io.stdout);
				return 0;
			case 'status':
				await status(options, io.stdout);
				return 0;
			case 'stop':
				await stop(options, io.stdout);
				return 0;
			default:
				throw new Error(`Unknown remote shell action: ${options.action}`);
		}
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export function parseCliOptions(argv: string[]): CliOptions {
	const action = argv[0] && argv[0].startsWith('--') === false ? argv[0] : 'launch';
	const args = action === argv[0] ? argv.slice(1) : argv;
	const workspaceRoot = path.resolve(readArg(args, '--workspace-root', process.cwd()));
	const extensionRoot = path.resolve(readArg(args, '--extension-root', path.resolve(__dirname, '..', '..')));
	const manifestPath = resolveManifestPath(workspaceRoot, readArg(args, '--manifest', path.join(workspaceRoot, 'remote_workspace', 'unity-shell.json')));
	const localPortBaseText = readArg(args, '--local-port-base', '');
	const localPortBase = localPortBaseText.length > 0 ? Number.parseInt(localPortBaseText, 10) : undefined;
	const shellAppPath = readArg(args, '--shell-app', '');

	return {
		action,
		manifestPath,
		workspaceRoot,
		extensionRoot,
		localPortBase: Number.isFinite(localPortBase) ? localPortBase : undefined,
		shellAppPath: shellAppPath.length > 0 ? expandWorkspaceToken(shellAppPath, workspaceRoot) : undefined
	};
}

export async function buildPlanFromOptions(options: CliOptions): Promise<RemoteShellPlan> {
	const { manifest } = await loadRemoteShellManifest(options.manifestPath);
	return createRemoteShellPlan(manifest, {
		manifestPath: options.manifestPath,
		extensionRoot: options.extensionRoot,
		localPortBase: options.localPortBase,
		shellAppPath: options.shellAppPath
	});
}

async function initManifest(options: CliOptions): Promise<void> {
	if (fs.existsSync(options.manifestPath)) {
		throw new Error(`Remote shell manifest already exists: ${options.manifestPath}`);
	}

	await fs.promises.mkdir(path.dirname(options.manifestPath), { recursive: true });
	await fs.promises.writeFile(options.manifestPath, JSON.stringify(createExampleManifest(), null, 2) + '\n', 'utf8');
	process.stdout.write(`Created ${options.manifestPath}\n`);
}

async function printPlan(options: CliOptions, stdout: NodeJS.WritableStream): Promise<void> {
	const plan = await buildPlanFromOptions(options);
	stdout.write(JSON.stringify(plan, null, 2) + '\n');
}

async function launch(options: CliOptions, stdout: NodeJS.WritableStream): Promise<void> {
	const plan = await buildPlanFromOptions(options);
	const tunnel = spawnDetached(plan.sshTunnel, 'unity-vdd-shell tunnel');
	const remoteStart = spawnDetached(plan.remoteStart, 'unity-vdd-shell remote start');
	const shell = spawnDetached(plan.shellLaunch, 'unity-vdd-shell native shell');
	const state: SessionState = {
		manifestPath: plan.manifestPath,
		statePath: plan.statePath,
		startedAt: new Date().toISOString(),
		links: plan.links,
		session: withSessionLifecycle(plan.session, 'running'),
		pids: {
			sshTunnel: tunnel.pid,
			remoteStart: remoteStart.pid,
			shell: shell.pid
		}
	};

	await writeSessionState(plan.statePath, state);
	stdout.write(JSON.stringify({
		success: true,
		message: 'Unity VDD shell launch requested.',
		links: plan.links,
		session: state.session,
		pids: state.pids,
		statePath: plan.statePath
	}, null, 2) + '\n');
}

async function status(options: CliOptions, stdout: NodeJS.WritableStream): Promise<void> {
	const plan = await buildPlanFromOptions(options);
	const state = await readSessionState(plan.statePath);
	const remoteStatus = state ? await httpJson(state.links.statusUrl).catch((error) => ({ success: false, error: error.message })) : null;
	stdout.write(JSON.stringify({
		success: true,
		statePath: plan.statePath,
		session: state,
		remoteStatus
	}, null, 2) + '\n');
}

async function stop(options: CliOptions, stdout: NodeJS.WritableStream): Promise<void> {
	const plan = await buildPlanFromOptions(options);
	const state = await readSessionState(plan.statePath);
	let remoteStop: unknown = null;
	if (state) {
		remoteStop = await httpJson(`${state.links.controlUrl}/stop`, 'POST').catch((error) => ({ success: false, error: error.message }));
		for (const pid of [state.pids.shell, state.pids.remoteStart, state.pids.sshTunnel]) {
			killPid(pid);
		}
		await fs.promises.rm(plan.statePath, { force: true });
	}

	stdout.write(JSON.stringify({
		success: true,
		stopped: state != null,
		remoteStop,
		session: state ? withSessionLifecycle(state.session, 'stopped') : undefined,
		statePath: plan.statePath
	}, null, 2) + '\n');
}

function spawnDetached(plan: CommandPlan, label: string): ReturnType<typeof spawn> {
	const child = spawn(plan.command, plan.args, {
		detached: true,
		stdio: 'ignore'
	});
	child.on('error', (error) => {
		process.stderr.write(`${label} failed: ${error.message}\n`);
	});
	child.unref();
	return child;
}

async function writeSessionState(statePath: string, state: SessionState): Promise<void> {
	await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
	await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function readSessionState(statePath: string): Promise<SessionState | null> {
	try {
		return JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as SessionState;
	} catch {
		return null;
	}
}

function httpJson(url: string, method = 'GET'): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = http.request(url, { method, timeout: 2_000 }, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				try {
					resolve(body.trim().length > 0 ? JSON.parse(body) : { statusCode: response.statusCode });
				} catch {
					resolve({ statusCode: response.statusCode, body });
				}
			});
		});
		request.on('error', reject);
		request.on('timeout', () => {
			request.destroy(new Error(`Timed out requesting ${url}`));
		});
		request.end();
	});
}

function killPid(pid: number | undefined): void {
	if (pid == null || pid <= 0) {
		return;
	}

	try {
		process.kill(pid);
	} catch {
		// The process may have already exited; stop remains best-effort.
	}
}

function readArg(args: string[], name: string, fallback: string): string {
	const index = args.indexOf(name);
	if (index >= 0 && index < args.length - 1) {
		return args[index + 1];
	}

	const prefix = `${name}=`;
	const inline = args.find((arg) => arg.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

function expandWorkspaceToken(value: string, workspaceRoot: string): string {
	return value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}

if (require.main === module) {
	void runCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
