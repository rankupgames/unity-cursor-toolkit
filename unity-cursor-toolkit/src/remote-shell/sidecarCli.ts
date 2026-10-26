#!/usr/bin/env node

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { createExampleManifest, loadRemoteShellManifest, parseRemoteShellDoctorManifest, resolveManifestPath } from './manifest';
import { CommandPlan, RemoteShellPlan, createRemoteShellPlan, createRemoteShellDoctorPlans, REMOTE_SHELL_SIDECAR_VERSION } from './sidecarPlan';
import { withSessionLifecycle, type UnityHostSessionSnapshot } from './session';

interface CliOptions {
	readonly action: string;
	readonly format: string;
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
			case 'doctor':
				return await doctor(options, io.stdout);
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
		format: readArg(args, '--format', 'human'),
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


type DoctorCheckId = 'manifest' | 'localpaths' | 'ssh' | 'remotepaths' | 'sidecarversion' | 'license';
interface DoctorCheck {
	id: DoctorCheckId;
	state: 'pass' | 'fail';
	code: string;
	message: string;
	remediation: string;
}
interface DoctorResult {
	success: boolean;
	checks: DoctorCheck[];
	sidecarVersion: string | null;
	licenseState: 'active' | 'inactive' | 'unknown';
}

async function doctor(options: CliOptions, stdout: NodeJS.WritableStream): Promise<number> {
	const checks: DoctorCheck[] = [];
	const result: DoctorResult = { success: false, checks, sidecarVersion: null, licenseState: 'unknown' };
	const add = (id: DoctorCheckId, pass: boolean, code: string, message: string, remediation: string): void => {
		checks.push({ id, state: pass ? 'pass' : 'fail', code, message, remediation });
	};
	let manifest: ReturnType<typeof parseRemoteShellDoctorManifest> | undefined;
	if (!['human', 'json'].includes(options.format)) {
		add('manifest', false, 'invalid_format', 'Doctor output format is invalid.', 'Use --format human or --format json.');
	} else {
		try {
			manifest = parseRemoteShellDoctorManifest(JSON.parse(await fs.promises.readFile(options.manifestPath, 'utf8')));
			add('manifest', true, 'ok', 'Manifest fields and remote path syntax are valid.', 'No action required.');
		} catch {
			add('manifest', false, 'invalid_manifest', 'Manifest is missing, unreadable, malformed, or invalid.',
				'Provide a readable manifest with required fields, valid SSH target, and absolute Windows remote paths.');
		}
	}
	let localReady = false;
	if (manifest) {
		try {
			if (!(await fs.promises.stat(options.workspaceRoot)).isDirectory()
				|| !(await fs.promises.stat(options.extensionRoot)).isDirectory()) {
				throw new Error('Local path unavailable.');
			}
			const shellPath = options.shellAppPath?.trim();
			if (!shellPath) {
				if (!(await fs.promises.stat(path.join(options.extensionRoot, 'native-shell', 'UnityVddShell', 'Package.swift'))).isFile()) {
					throw new Error('Native shell sources unavailable.');
				}
				if (!(await runDoctorCommand({ command: 'swift', args: ['--version'] })).ok) { throw new Error('Swift unavailable.'); }
			} else {
				const stat = await fs.promises.stat(shellPath);
				if (shellPath.endsWith('.app') ? !stat.isDirectory() : !stat.isFile()) { throw new Error('Shell unavailable.'); }
				await fs.promises.access(shellPath, process.platform === 'win32' || shellPath.endsWith('.app') ? fs.constants.R_OK : fs.constants.X_OK);
			}
			localReady = true;
			add('localpaths', true, 'ok', 'Local workspace, extension, and shell paths resolve.', 'No action required.');
		} catch {
			add('localpaths', false, 'local_paths_unavailable', 'A required local path or shell dependency is unavailable.',
				'Check workspace and extension paths; provide an installed shell app or prepare Swift and the native shell sources.');
		}
	} else {
		add('localpaths', false, 'prerequisite_failed', 'Manifest validation must pass first.', 'Correct the manifest and run doctor again.');
	}
	if (manifest && localReady) {
		const plans = createRemoteShellDoctorPlans(manifest);
		const reachable = await runDoctorCommand(plans.ssh);
		const sshReady = reachable.ok && readDoctorJson(reachable.stdout)?.reachable === true;
		add('ssh', sshReady, sshReady ? 'ok' : sshFailureCode(reachable),
			sshReady ? 'Non-interactive SSH reachability passed.' : 'Non-interactive SSH reachability failed.',
			sshReady ? 'No action required.' : 'Verify the SSH alias, network, existing host-key trust, and non-interactive authentication outside doctor.');
		if (sshReady) {
			const remote = await runDoctorCommand(plans.remotepaths);
			const remoteData = readDoctorJson(remote.stdout);
			const keys = ['workspace', 'player', 'sidecar', 'ffmpeg', ...(manifest.unityEditorPath ? ['editor'] : []), ...(manifest.remoteRepoPath ? ['repo'] : [])];
			const pathsReady = remote.ok && remoteData != null && keys.every(key => remoteData[key] === true);
			add('remotepaths', pathsReady, pathsReady ? 'ok' : 'remote_paths_unavailable',
				pathsReady ? 'Configured remote paths and FFmpeg resolve.' : 'Remote path or dependency checks failed.',
				pathsReady ? 'No action required.' : 'Prepare the remote workspace, Player, sidecar, optional Editor/repository, and FFmpeg outside doctor.');
			if (pathsReady) {
				const version = await runDoctorCommand(plans.sidecarversion);
				const observed = readDoctorJson(version.stdout)?.sidecarVersion;
				// Publish only a version-shaped value, never arbitrary remote text.
				if (version.ok && typeof observed === 'string' && /^\d+\.\d+\.\d+$/.test(observed) && observed.length <= 32) { result.sidecarVersion = observed; }
				const versionReady = result.sidecarVersion === REMOTE_SHELL_SIDECAR_VERSION;
				add('sidecarversion', versionReady, versionReady ? 'ok' : result.sidecarVersion ? 'sidecar_version_mismatch' : 'sidecar_version_unavailable',
					versionReady ? 'Remote sidecar version matches the local contract.' : 'Remote sidecar version is unavailable or does not match.',
					versionReady ? 'No action required.' : 'Verify the trusted bundled sidecar and host script execution policy. Deploy the matching sidecar, then run doctor again.');
			} else {
				add('sidecarversion', false, 'prerequisite_failed', 'Remote path validation must pass first.', 'Correct remote paths and run doctor again.');
			}
		} else {
			add('remotepaths', false, 'prerequisite_failed', 'SSH reachability must pass first.', 'Correct SSH access and run doctor again.');
			add('sidecarversion', false, 'prerequisite_failed', 'SSH reachability must pass first.', 'Correct SSH access and run doctor again.');
		}
	} else {
		for (const id of ['ssh', 'remotepaths', 'sidecarversion'] as const) {
			add(id, false, 'prerequisite_failed', 'Local manifest and path checks must pass first.', 'Correct the local checks and run doctor again.');
		}
	}
	// Official license status may install/replace its client; no proven no-install contract is available.
	add('license', false, 'license_probe_unavailable', 'Remote Unity license state is unknown; no safe non-installing probe is available.',
		'Have the operator verify the active Unity license with official tools outside doctor. Doctor never installs, activates, returns, or signs out.');
	result.success = checks.every(check => check.state === 'pass');
	if (options.format === 'json') {
		stdout.write(JSON.stringify(result, null, 2) + '\n');
	} else {
		stdout.write('Remote shell doctor: ' + (result.success ? 'PASS' : 'FAIL') + '\n');
		for (const check of checks) { stdout.write(check.id + ': ' + check.state.toUpperCase() + ' [' + check.code + '] ' + check.message + '\n  ' + check.remediation + '\n'); }
		stdout.write('sidecarVersion: ' + (result.sidecarVersion ?? 'unknown') + '\nlicenseState: ' + result.licenseState + '\n');
	}
	return result.success ? 0 : 1;
}

function readDoctorJson(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}

function runDoctorCommand(plan: CommandPlan): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean; missing: boolean }> {
	return new Promise(resolve => {
		execFile(plan.command, plan.args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
			resolve({ ok: error == null, stdout, stderr, timedOut: error?.killed === true, missing: error?.code === 'ENOENT' });
		});
	});
}

function sshFailureCode(result: { timedOut: boolean; missing: boolean; stderr: string }): string {
	if (result.timedOut) { return 'ssh_timed_out'; }
	if (result.missing) { return 'ssh_unavailable'; }
	if (/Permission denied/i.test(result.stderr)) { return 'ssh_auth_failed'; }
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) { return 'ssh_host_key_failed'; }
	if (/Could not resolve hostname/i.test(result.stderr)) { return 'ssh_name_unresolved'; }
	if (/Connection refused/i.test(result.stderr)) { return 'ssh_refused'; }
	return 'ssh_failed';
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
	const plan = await buildPlanFromOptions(options).catch(() => { throw new Error('[doctor:manifest] Launch manifest or plan is invalid. Run remote-shell doctor.'); });
	const tunnel = spawnDetached(plan.sshTunnel, 'unity-vdd-shell tunnel [doctor:ssh]');
	const remoteStart = spawnDetached(plan.remoteStart, 'unity-vdd-shell remote start [doctor:remotepaths]');
	const shell = spawnDetached(plan.shellLaunch, 'unity-vdd-shell native shell [doctor:localpaths]');
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
