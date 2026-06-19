#!/usr/bin/env node
/**
 * Packages and installs the Unity Cursor Toolkit VSIX into an isolated Cursor
 * profile, then records whether the installed extension exposes the viewport
 * command surface needed for the editor/player rendering lanes.
 *
 * This runner avoids mutating the user's normal Cursor profile by default.
 * Use --open to launch the workspace for human/Computer Use visual inspection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const defaultResult = path.join(repoRoot, 'experiments', 'installed-cursor-smoke', 'results', `${dateStamp()}-current.json`);
const viewportProofOut = getStringArg('--viewport-proof-out', getStringArg('--proof-out', ''));
const options = {
	cursorCli: getStringArg('--cursor', process.env.CURSOR_CLI || 'cursor'),
	workspace: path.resolve(getStringArg('--workspace', path.join(repoRoot, 'unity-viewport-prototype.code-workspace'))),
	vsix: path.resolve(getStringArg('--vsix', path.join(os.tmpdir(), 'unity-cursor-toolkit-smoke.vsix'))),
	out: path.resolve(getStringArg('--out', defaultResult)),
	userDataDir: path.resolve(getStringArg('--user-data-dir', path.join(os.tmpdir(), 'uct-cursor-smoke-user-data'))),
	extensionsDir: path.resolve(getStringArg('--extensions-dir', path.join(os.tmpdir(), 'uct-cursor-smoke-extensions'))),
	profile: getStringArg('--profile', ''),
	waitSeconds: getIntArg('--wait-seconds', 8),
	screenshot: getStringArg('--screenshot', ''),
	viewportProofOut: viewportProofOut ? path.resolve(viewportProofOut) : '',
	viewportProofTimeoutMs: getIntArg('--viewport-proof-timeout-ms', getIntArg('--proof-timeout-ms', 90_000)),
	noPackage: hasFlag('--no-package'),
	open: hasFlag('--open') || viewportProofOut.length > 0,
	keepOpen: hasFlag('--keep-open'),
	force: hasFlag('--force') || true,
	dryRun: hasFlag('--dry-run')
};

const expectedCommands = [
	'unity-cursor-toolkit.viewport.openSceneView',
	'unity-cursor-toolkit.viewport.openGameView',
	'unity-cursor-toolkit.viewport.openPlayerSceneView',
	'unity-cursor-toolkit.viewport.openPlayerGameView',
	'unity-cursor-toolkit.viewport.openInspector',
	'unity-cursor-toolkit.viewport.openPackageManager',
	'unity-cursor-toolkit.viewport.openCustomWindow'
];

const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	platform: process.platform,
	osRelease: os.release(),
	nodeVersion: process.version,
	mode: 'installed-cursor-viewport-smoke',
	status: 'unknown',
	cursorCli: options.cursorCli,
	workspace: options.workspace,
	vsix: options.vsix,
	userDataDir: options.userDataDir,
	extensionsDir: options.extensionsDir,
	profile: options.profile,
	openRequested: options.open,
	dryRun: options.dryRun,
	expectedCommands,
	commandManifest: [],
	installedExtensions: [],
	steps: [],
	manualVerification: {
		requiredForPixelProof: true,
		editorCommands: [
			'Unity Toolkit: Open Scene View',
			'Unity Toolkit: Open Game View'
		],
		playerCommands: [
			'Unity Toolkit: Open Player Scene View',
			'Unity Toolkit: Open Player Game View'
		],
		successSignal: 'Cursor webview panels show live <img> frames marked Streaming; editor panels use host:"editor"/captureMode:"editorWindow", player panels use host:"player"/captureMode:"camera".'
	},
	viewportProof: {
		requested: options.viewportProofOut.length > 0,
		path: options.viewportProofOut || null,
		timeoutMs: options.viewportProofTimeoutMs,
		workspace: null,
		result: null
	},
	cleanup: {
		isolatedCursorRequested: false,
		terminatedPids: [],
		sigkilledPids: [],
		skipped: null
	},
	errors: []
};

let openedIsolatedCursorForProof = false;
let cleanupStarted = false;

main().catch(async (error) => {
	recordError(error.message || String(error));
	await cleanupAfterRun();
	finish('fail');
});

async function main() {
	console.log('Unity Cursor Toolkit -- Installed Cursor Viewport Smoke\n');
	console.log(`Cursor CLI: ${options.cursorCli}`);
	console.log(`VSIX:       ${options.vsix}`);
	console.log(`Workspace:  ${options.workspace}`);
	console.log(`Out:        ${options.out}`);

	readAndValidatePackageManifest();
	writeReport();

	if (options.noPackage === false) {
		await runStep('package-vsix', executable('npx'), ['--no-install', 'vsce', 'package', '--no-dependencies', '--out', options.vsix], {
			cwd: extensionRoot,
			timeoutMs: 120_000
		});
	}
	if (options.dryRun === false) {
		requireFile(options.vsix, 'VSIX');
	}

	await runStep('cursor-version', cursorCommand(), ['--version'], { timeoutMs: 20_000, allowFailure: false });
	await runStep('install-extension', cursorCommand(), [
		'--user-data-dir', options.userDataDir,
		'--extensions-dir', options.extensionsDir,
		'--install-extension', options.vsix,
		'--force'
	], { timeoutMs: 120_000 });

	const listStep = await runStep('list-extensions', cursorCommand(), [
		'--user-data-dir', options.userDataDir,
		'--extensions-dir', options.extensionsDir,
		'--list-extensions',
		'--show-versions'
	], { timeoutMs: 60_000 });
	report.installedExtensions = listStep.stdout.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);

	if (options.dryRun) {
		report.manualVerification.note = 'Dry run only: commands were planned but Cursor was not installed/opened.';
		finish('pass');
		return;
	}

	const installed = report.installedExtensions.some(line => /^rankupgames\.unity-cursor-toolkit(@|$)/.test(line));
	if (installed === false) {
		throw new Error('rankupgames.unity-cursor-toolkit was not listed after isolated Cursor install');
	}

	if (options.open) {
		const workspaceToOpen = options.viewportProofOut ? createViewportProofWorkspace() : options.workspace;
		await runStep('open-workspace', cursorCommand(), [
			'--user-data-dir', options.userDataDir,
			'--extensions-dir', options.extensionsDir,
			...manualProfileArgs(),
			'--new-window',
			'--suppress-popups-on-startup',
			workspaceToOpen
		], { timeoutMs: 30_000, env: viewportProofEnv() });
		openedIsolatedCursorForProof = options.viewportProofOut.length > 0 && options.keepOpen === false;
		if (options.viewportProofOut) {
			report.viewportProof.result = await waitForViewportProof();
			writeReport();
		} else {
			await sleep(options.waitSeconds * 1000);
		}
		if (options.screenshot) {
			await captureScreenshot(path.resolve(options.screenshot));
		}
	} else {
		report.manualVerification.note = 'Run again with --open and inspect the listed commands in Cursor for UI-level panel proof.';
	}

	await cleanupAfterRun();
	finish('pass');
}

function createViewportProofWorkspace() {
	const original = JSON.parse(fs.readFileSync(options.workspace, 'utf8'));
	const workspaceDir = path.dirname(options.workspace);
	const folders = Array.isArray(original.folders)
		? original.folders.map((folder) => ({
			...folder,
			path: typeof folder.path === 'string' ? path.resolve(workspaceDir, folder.path) : folder.path
		}))
		: [];
	const workspace = {
		...original,
		folders,
		settings: {
			...(original.settings || {}),
			'unityCursorToolkit.viewportProof.out': options.viewportProofOut,
			'unityCursorToolkit.viewportProof.timeoutMs': options.viewportProofTimeoutMs
		}
	};
	const proofWorkspace = path.join(os.tmpdir(), `uct-cursor-viewport-proof-${Date.now()}.code-workspace`);
	fs.writeFileSync(proofWorkspace, JSON.stringify(workspace, null, 2) + '\n');
	report.viewportProof.workspace = proofWorkspace;
	writeReport();
	return proofWorkspace;
}

function readAndValidatePackageManifest() {
	const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
	const contributedCommands = (manifest.contributes?.commands || []).map(command => command.command);
	report.commandManifest = contributedCommands.filter(command => expectedCommands.includes(command));
	const missing = expectedCommands.filter(command => contributedCommands.includes(command) === false);
	if (missing.length > 0) {
		throw new Error(`package manifest is missing viewport commands: ${missing.join(', ')}`);
	}
}

async function runStep(name, command, args, stepOptions = {}) {
	const startedAt = Date.now();
	const step = {
		name,
		command,
		args,
		startedAt: new Date(startedAt).toISOString(),
		exitCode: null,
		durationMs: null,
		stdout: '',
		stderr: '',
		skipped: options.dryRun
	};
	report.steps.push(step);
	writeReport();

	if (options.dryRun) {
		console.log(`[dry-run] ${formatCommand(command, args)}`);
		step.exitCode = 0;
		step.durationMs = 0;
		writeReport();
		return step;
	}

	console.log(`\n== ${name} ==`);
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, {
			cwd: stepOptions.cwd || repoRoot,
			env: stepOptions.env || process.env,
			timeout: stepOptions.timeoutMs || 60_000,
			maxBuffer: 1024 * 1024 * 8
		}, (error, stdout, stderr) => {
			step.durationMs = Date.now() - startedAt;
			step.stdout = stdout || '';
			step.stderr = stderr || '';
			step.exitCode = error && typeof error.code === 'number' ? error.code : 0;
			writeReport();
			if (stdout) {
				process.stdout.write(stdout);
			}
			if (stderr) {
				process.stderr.write(stderr);
			}
			if (error && stepOptions.allowFailure !== true) {
				reject(error);
				return;
			}
			resolve(step);
		});
		child.on('error', (error) => {
			step.durationMs = Date.now() - startedAt;
			step.stderr = error.message || String(error);
			step.exitCode = 1;
			writeReport();
			reject(error);
		});
	});
}

async function waitForViewportProof() {
	const started = Date.now();
	let lastProof = null;
	while (Date.now() - started < options.viewportProofTimeoutMs) {
		if (fs.existsSync(options.viewportProofOut)) {
			try {
				lastProof = JSON.parse(fs.readFileSync(options.viewportProofOut, 'utf8'));
				if (lastProof.status === 'pass') {
					return lastProof;
				}
				if (lastProof.status === 'fail') {
					throw new Error(`installed Cursor viewport proof failed: ${lastProof.error || 'unknown error'}`);
				}
			} catch (error) {
				if (lastProof?.status === 'fail') {
					throw error;
				}
			}
		}
		await sleep(500);
	}
	throw new Error(`timed out waiting for installed Cursor viewport proof at ${options.viewportProofOut}${lastProof ? `; last status: ${lastProof.status}` : ''}`);
}

function viewportProofEnv() {
	if (!options.viewportProofOut) {
		return process.env;
	}
	return {
		...process.env,
		UNITY_CURSOR_TOOLKIT_PROJECT_PATH: path.join(repoRoot, 'CursorUnityTool'),
		UNITY_CURSOR_TOOLKIT_VIEWPORT_PROOF_OUT: options.viewportProofOut,
		UNITY_CURSOR_TOOLKIT_VIEWPORT_PROOF_TIMEOUT_MS: String(options.viewportProofTimeoutMs)
	};
}

function manualProfileArgs() {
	if (options.viewportProofOut || options.profile.length === 0) {
		return [];
	}
	return ['--profile', options.profile];
}

async function captureScreenshot(targetPath) {
	if (process.platform !== 'darwin') {
		report.manualVerification.screenshotSkipped = `screencapture is only implemented for macOS in this runner; current platform is ${process.platform}`;
		writeReport();
		return;
	}
	await runStep('capture-screenshot', 'screencapture', ['-x', targetPath], { timeoutMs: 30_000 });
	report.manualVerification.screenshot = targetPath;
	writeReport();
}

function requireFile(filePath, label) {
	if (fs.existsSync(filePath) === false) {
		throw new Error(`${label} not found: ${filePath}`);
	}
}

function finish(status) {
	report.status = status;
	report.finishedAt = new Date().toISOString();
	writeReport();
	console.log(`\nStatus: ${status.toUpperCase()}`);
	console.log(`Wrote ${options.out}`);
	if (status !== 'pass') {
		process.exitCode = 1;
	}
}

function recordError(message) {
	report.errors.push({
		at: new Date().toISOString(),
		message
	});
	writeReport();
}

async function cleanupAfterRun() {
	if (cleanupStarted || openedIsolatedCursorForProof === false) {
		return;
	}
	cleanupStarted = true;
	report.cleanup.isolatedCursorRequested = true;
	writeReport();

	if (process.platform === 'win32') {
		report.cleanup.skipped = 'isolated Cursor cleanup is not implemented on Windows yet';
		writeReport();
		return;
	}

	const pids = await findIsolatedCursorPids();
	report.cleanup.terminatedPids = pids;
	writeReport();
	for (const pid of pids) {
		try { process.kill(pid, 'SIGTERM'); } catch (error) { /* ignore exited process */ }
	}

	await sleep(1500);
	const survivors = pids.filter(pid => processExists(pid));
	report.cleanup.sigkilledPids = survivors;
	writeReport();
	for (const pid of survivors) {
		try { process.kill(pid, 'SIGKILL'); } catch (error) { /* ignore exited process */ }
	}
}

function findIsolatedCursorPids() {
	return new Promise((resolve) => {
		execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 1024 * 1024 * 8 }, (error, stdout) => {
			if (error) {
				report.cleanup.skipped = `failed to inspect process table: ${error.message || String(error)}`;
				writeReport();
				resolve([]);
				return;
			}

			const pids = [];
			for (const line of String(stdout || '').split(/\r?\n/)) {
				const match = /^\s*(\d+)\s+(.+)$/.exec(line);
				if (match == null) {
					continue;
				}

				const pid = Number.parseInt(match[1], 10);
				const command = match[2];
				if (pid === process.pid || command.includes('smoke-installed-cursor-viewports.js')) {
					continue;
				}
				if (command.includes(options.userDataDir) && command.includes(options.extensionsDir)) {
					pids.push(pid);
				}
			}
			resolve(pids);
		});
	});
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code === 'EPERM';
	}
}

function writeReport() {
	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
}

function cursorCommand() {
	return executable(options.cursorCli);
}

function executable(command) {
	if (process.platform === 'win32' && /^[A-Za-z0-9_-]+$/.test(command)) {
		return `${command}.cmd`;
	}
	return command;
}

function formatCommand(command, args) {
	return [command, ...args].map(value => {
		const text = String(value);
		return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
	}).join(' ');
}

function dateStamp() {
	return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return fallback;
}

function getIntArg(name, fallback) {
	const value = Number.parseInt(getStringArg(name, ''), 10);
	return Number.isFinite(value) ? value : fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}
