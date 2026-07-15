#!/usr/bin/env node
/**
 * Windows proof runner for the "Unity Without The Editor" experiment series.
 *
 * This must be run on a Windows host with Unity installed. It orchestrates the
 * remaining acceptance gate: E1 DLL mount probe, E2 hidden real-EditorWindow
 * capture spike, installed Cursor editor Scene/Game frame proof, and E3
 * Viewport Service player build/probe/perf measurement.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const outRoot = normalizeUserPath(getStringArg('--out-root', path.join(repoRoot, 'experiments', 'windows-unity-without-editor', 'results', `${dateStamp()}-windows`)));
const unityPath = getStringArg('--unity-path', process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH || '');
const dryRun = hasFlag('--dry-run');
const preflightOnly = hasFlag('--preflight-only') || hasFlag('--preflight');
const force = hasFlag('--force');
const skipE1 = hasFlag('--skip-e1');
const skipE2 = hasFlag('--skip-e2');
const skipE3 = hasFlag('--skip-e3');
const skipCursorProof = hasFlag('--skip-cursor-proof');
const playerPort = getIntArg('--player-port', 55502);
const measurePort = getIntArg('--measure-port', 55503);
const playerPath = path.join(repoRoot, 'CursorUnityTool', 'Builds', 'ViewportService', 'ViewportService.exe');
const env = unityPath ? { ...process.env, UNITY_CURSOR_TOOLKIT_UNITY_PATH: unityPath } : process.env;
const reportPath = joinUnder(outRoot, 'windows-proof-summary.json');
const canWriteReport = process.platform === 'win32' || isWindowsAbsolute(outRoot) === false;
const artifactPaths = {
	preflight: joinUnder(outRoot, 'windows-proof-preflight.json'),
	e1DllMountProbe: joinUnder(outRoot, 'e1-dll-mount-probe-windows.json'),
	e2HiddenEditorSpikeMeasure: joinUnder(outRoot, 'e2-hidden-editor-spike-measure-windows.json'),
	e2HiddenEditorSpikeResult: joinUnder(outRoot, 'e2-hidden-editor-spike-result-windows.json'),
	installedCursorViewportSmoke: joinUnder(outRoot, 'installed-cursor-editor-scene-game-auto-smoke-windows.json'),
	installedCursorViewportProof: joinUnder(outRoot, 'installed-cursor-editor-scene-game-auto-proof-windows.json'),
	e3ViewportServiceProbeTranscript: joinUnder(outRoot, 'e3-viewport-service-probe-windows.txt'),
	e3ViewportServiceMeasurement: joinUnder(outRoot, 'e3-viewport-service-game-1280x720-30fps-windows.json')
};
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	completedAt: null,
	status: dryRun ? 'planned' : 'running',
	mode: preflightOnly ? (dryRun ? 'preflight-dry-run' : 'preflight') : (dryRun ? 'dry-run' : 'execute'),
	platform: process.platform,
	windowsHost: process.platform === 'win32',
	arch: process.arch,
	osRelease: os.release(),
	nodeVersion: process.version,
	repoRoot,
	outRoot,
	unityPath: unityPath || null,
	unityInstallRoot: unityPath ? unityInstallRoot(unityPath) : null,
	playerPath,
	ports: {
		player: playerPort,
		measure: measurePort
	},
	options: {
		preflightOnly,
		force,
		skipE1,
		skipE2,
		skipE3,
		skipCursorProof
	},
	preflight: [],
	steps: [],
	artifacts: {},
	errors: []
};

main().catch((error) => {
	report.status = 'fail';
	report.completedAt = new Date().toISOString();
	report.errors.push(error.message || String(error));
	writeReport();
	console.error('Windows proof failed: ' + (error.message || String(error)));
	process.exitCode = 1;
});

async function main() {
	console.log('Unity Cursor Toolkit -- Windows Unity Without Editor Proof\n');
	console.log(`Repo:     ${repoRoot}`);
	console.log(`Out root: ${outRoot}`);
	console.log(`Unity:    ${unityPath || '(resolve from CursorUnityTool ProjectVersion.txt)'}`);
	console.log(`Mode:     ${report.mode}\n`);

	if (process.platform !== 'win32' && dryRun === false) {
		throw new Error('this proof runner must execute on Windows; pass --dry-run to print the command plan from another host');
	}

	fs.mkdirSync(outRoot, { recursive: true });
	writeReport();
	await runPreflight();
	recordArtifact('preflight', artifactPaths.preflight);
	const preflightFailed = report.preflight.some((check) => check.status === 'fail');
	if (preflightFailed) {
		throw new Error('Windows proof preflight failed; fix failed checks before running the full proof');
	}
	if (preflightOnly) {
		report.status = dryRun ? 'planned' : 'pass';
		report.completedAt = new Date().toISOString();
		writeReport();
		console.log(`\nPreflight: ${report.status.toUpperCase()}`);
		console.log(`Summary: ${reportPath}`);
		return;
	}

	if (skipE1 === false) {
		await runStep('E1 DLL mount probe', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet', [
			'run',
			'--project', path.join(repoRoot, 'experiments', 'editor-dll-mount-probe'),
			'--',
			'--out', artifactPaths.e1DllMountProbe,
			...(unityPath ? ['--unity-app', unityInstallRoot(unityPath)] : [])
		]);
		recordArtifact('e1DllMountProbe', artifactPaths.e1DllMountProbe);
	}

	if (skipE2 === false) {
		await runStep('E2 hidden editor-window capture spike', process.execPath, [
			path.join(extensionRoot, 'scripts', 'run-editor-window-capture-spike.js'),
			'--hide',
			'--measure',
			'--timeout', '420',
			'--measure-out', artifactPaths.e2HiddenEditorSpikeMeasure,
			...(force ? ['--force'] : [])
		]);
		recordArtifact('e2HiddenEditorSpikeMeasure', artifactPaths.e2HiddenEditorSpikeMeasure);
		await copyIfExists(path.join(os.tmpdir(), 'uct-editor-window-spike-result.json'), artifactPaths.e2HiddenEditorSpikeResult);
		recordArtifact('e2HiddenEditorSpikeResult', artifactPaths.e2HiddenEditorSpikeResult);
	}

	if (skipCursorProof === false) {
		await runStep('Installed Cursor automated editor Scene/Game frame proof', process.execPath, [
			path.join(extensionRoot, 'scripts', 'smoke-installed-cursor-viewports.js'),
			'--out', artifactPaths.installedCursorViewportSmoke,
			'--viewport-proof-out', artifactPaths.installedCursorViewportProof,
			'--viewport-proof-timeout-ms', '180000',
			'--user-data-dir', joinUnder(outRoot, 'cursor-proof-user-data'),
			'--extensions-dir', joinUnder(outRoot, 'cursor-proof-extensions')
		]);
		recordArtifact('installedCursorViewportSmoke', artifactPaths.installedCursorViewportSmoke);
		recordArtifact('installedCursorViewportProof', artifactPaths.installedCursorViewportProof);
	}

	if (skipE3 === false) {
		await runStep('E3 build Viewport Service Windows player', process.execPath, [
			path.join(extensionRoot, 'scripts', 'build-viewport-service.js'),
			'--target', 'windows',
			'--timeout', '900',
			'--out', playerPath,
			...(force ? ['--force'] : [])
		]);

		await runStep('E3 launch Viewport Service for probe', process.execPath, [
			path.join(extensionRoot, 'scripts', 'run-viewport-service.js'),
			'--player', playerPath,
			'--port', String(playerPort),
			'--hide',
			'--timeout', '60'
		]);

		await runStep('E3 probe Viewport Service scene/game/input', process.execPath, [
			path.join(extensionRoot, 'scripts', 'probe-viewport-service.js')
		], {
			env: { ...env, UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(playerPort) },
			transcriptPath: artifactPaths.e3ViewportServiceProbeTranscript
		});
		recordArtifact('e3ViewportServiceProbeTranscript', artifactPaths.e3ViewportServiceProbeTranscript);
		await stopWindowsListener(playerPort);

		await runStep('E3 measure Viewport Service 1280x720@30', process.execPath, [
			path.join(extensionRoot, 'scripts', 'measure-viewport-service.js'),
			'--player', playerPath,
			'--port', String(measurePort),
			'--view', 'game',
			'--width', '1280',
			'--height', '720',
			'--fps', '30',
			'--quality', '72',
			'--idle-seconds', '5',
			'--duration', '30',
			'--timeout', '90',
			'--hide',
			'--out', artifactPaths.e3ViewportServiceMeasurement
		]);
		recordArtifact('e3ViewportServiceMeasurement', artifactPaths.e3ViewportServiceMeasurement);
	}

	report.status = dryRun ? 'planned' : 'pass';
	report.completedAt = new Date().toISOString();
	writeReport();

	console.log('\nWindows proof runner finished.');
	console.log(`Archive result files from: ${outRoot}`);
	if (canWriteReport) {
		console.log(`Summary: ${reportPath}`);
	} else {
		console.log('Summary: not written because this non-Windows dry run used a Windows-style output path.');
	}
}

async function runPreflight() {
	console.log('\n== Preflight ==');
	addPreflightCheck('platform', process.platform === 'win32' ? 'pass' : (dryRun ? 'planned' : 'fail'), `platform=${process.platform}`, {
		required: 'win32'
	});
	addPreflightCheck('node', 'pass', `node=${process.version}`, {
		executable: process.execPath
	});
	checkPath('repo-root', repoRoot, 'directory');
	checkPath('extension-root', extensionRoot, 'directory');
	checkPath('unity-project', path.join(repoRoot, 'CursorUnityTool'), 'directory');
	checkPath('unity-project-assets', path.join(repoRoot, 'CursorUnityTool', 'Assets'), 'directory');
	checkPath('unity-project-version', path.join(repoRoot, 'CursorUnityTool', 'ProjectSettings', 'ProjectVersion.txt'), 'file');
	checkPath('editor-dll-mount-probe-project', path.join(repoRoot, 'experiments', 'editor-dll-mount-probe'), 'directory');
	checkPath('viewport-proof-script', path.join(extensionRoot, 'scripts', 'smoke-installed-cursor-viewports.js'), 'file');
	checkPath('viewport-service-build-script', path.join(extensionRoot, 'scripts', 'build-viewport-service.js'), 'file');
	await checkUnityEditorPath();
	checkUnityLockfile();
	checkCommand('npm', ['--version'], 'npm');
	checkCommand('npx', ['--no-install', 'vsce', '--version'], 'vsce');
	checkCommand('dotnet', ['--version'], 'dotnet');
	checkCommand('cursor', ['--version'], 'cursor');
	checkCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.ToString()'], 'powershell');
	await checkPortAvailable('player-port', playerPort);
	await checkPortAvailable('measure-port', measurePort);
	writeJson(artifactPaths.preflight, {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		mode: report.mode,
		platform: process.platform,
		windowsHost: process.platform === 'win32',
		outRoot,
		checks: report.preflight,
		counts: countPreflight(report.preflight)
	});
	writeReport();
}

function addPreflightCheck(id, status, summary, details = {}) {
	const check = {
		id,
		status,
		summary,
		details
	};
	report.preflight.push(check);
	const marker = status.toUpperCase().padEnd(7);
	console.log(`${marker} ${id}: ${summary}`);
	writeReport();
}

function checkPath(id, target, kind) {
	if (dryRun && process.platform !== 'win32' && isWindowsAbsolute(target)) {
		addPreflightCheck(id, 'planned', `would check ${kind}: ${target}`);
		return;
	}
	const exists = fs.existsSync(target);
	const ok = exists && (kind === 'directory' ? fs.statSync(target).isDirectory() : fs.statSync(target).isFile());
	addPreflightCheck(id, ok ? 'pass' : 'fail', `${kind} ${ok ? 'found' : 'missing'}: ${target}`);
}

async function checkUnityEditorPath() {
	const candidate = unityPath || defaultWindowsUnityPathFromProjectVersion();
	if (!candidate) {
		addPreflightCheck('unity-editor-path', 'fail', 'could not resolve Unity editor path; pass --unity-path or set UNITY_CURSOR_TOOLKIT_UNITY_PATH');
		return;
	}
	if (dryRun && process.platform !== 'win32') {
		addPreflightCheck('unity-editor-path', 'planned', `would check Unity editor executable: ${candidate}`, {
			source: unityPath ? 'argument-or-env' : 'ProjectVersion.txt'
		});
		return;
	}
	const ok = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
	addPreflightCheck('unity-editor-path', ok ? 'pass' : 'fail', `Unity editor executable ${ok ? 'found' : 'missing'}: ${candidate}`, {
		source: unityPath ? 'argument-or-env' : 'ProjectVersion.txt'
	});
}

function checkUnityLockfile() {
	const lockfile = path.join(repoRoot, 'CursorUnityTool', 'Temp', 'UnityLockfile');
	if (dryRun && process.platform !== 'win32') {
		addPreflightCheck('unity-lockfile', 'planned', `would check Windows Unity project lockfile: ${lockfile}`);
		return;
	}
	if (fs.existsSync(lockfile) && force === false) {
		addPreflightCheck('unity-lockfile', 'fail', `Unity project lockfile exists: ${lockfile}; close Unity or pass --force`);
		return;
	}
	addPreflightCheck('unity-lockfile', 'pass', fs.existsSync(lockfile) ? `lockfile exists but --force is set: ${lockfile}` : 'no Unity project lockfile');
}

function checkCommand(commandName, args, id) {
	if (dryRun && process.platform !== 'win32') {
		addPreflightCheck(id, 'planned', `would run ${formatCommand(commandForPlatform(commandName), args)}`);
		return;
	}
	const command = commandForPlatform(commandName);
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		env,
		encoding: 'utf8',
		shell: false,
		maxBuffer: 1024 * 1024
	});
	if (result.error) {
		addPreflightCheck(id, 'fail', `${commandName} failed to start: ${result.error.message}`);
		return;
	}
	const stdout = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
	const stderr = String(result.stderr || '').trim().split(/\r?\n/).filter(Boolean);
	addPreflightCheck(id, result.status === 0 ? 'pass' : 'fail', `${commandName} ${result.status === 0 ? 'ok' : `exited ${result.status}`}`, {
		command: formatCommand(command, args),
		firstLine: stdout[0] || stderr[0] || ''
	});
}

function checkPortAvailable(id, port) {
	if (dryRun && process.platform !== 'win32') {
		addPreflightCheck(id, 'planned', `would check localhost port ${port}`);
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', (error) => {
			addPreflightCheck(id, 'fail', `localhost port ${port} is unavailable: ${error.message}`);
			resolve();
		});
		server.listen(port, '127.0.0.1', () => {
			server.close(() => {
				addPreflightCheck(id, 'pass', `localhost port ${port} is available`);
				resolve();
			});
		});
	});
}

function defaultWindowsUnityPathFromProjectVersion() {
	const projectVersionPath = path.join(repoRoot, 'CursorUnityTool', 'ProjectSettings', 'ProjectVersion.txt');
	if (fs.existsSync(projectVersionPath) === false) {
		return '';
	}
	const match = fs.readFileSync(projectVersionPath, 'utf8').match(/^m_EditorVersion:\s*(.+)$/m);
	const version = match ? match[1].trim() : '';
	return version ? path.win32.join('C:\\Program Files\\Unity\\Hub\\Editor', version, 'Editor', 'Unity.exe') : '';
}

function countPreflight(checks) {
	return checks.reduce((counts, check) => {
		counts[check.status] = (counts[check.status] || 0) + 1;
		return counts;
	}, {});
}

async function runStep(label, command, args, options = {}) {
	console.log(`\n== ${label} ==`);
	const step = {
		id: slugify(label),
		label,
		command,
		args,
		env: publicEnv(options.env),
		commandLine: formatCommand(command, args, options.env),
		startedAt: new Date().toISOString(),
		finishedAt: null,
		status: dryRun ? 'planned' : 'running',
		exitCode: null,
		...(options.transcriptPath ? { transcript: artifactRecord(options.transcriptPath) } : {})
	};
	report.steps.push(step);
	writeReport();

	if (dryRun) {
		console.log(step.commandLine);
		step.finishedAt = new Date().toISOString();
		writeReport();
		return;
	}

	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			env: options.env || env,
			stdio: options.transcriptPath ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		const chunks = [];
		if (options.transcriptPath) {
			child.stdout.on('data', (chunk) => {
				chunks.push(Buffer.from(chunk));
				process.stdout.write(chunk);
			});
			child.stderr.on('data', (chunk) => {
				chunks.push(Buffer.from(chunk));
				process.stderr.write(chunk);
			});
		}
		child.on('error', (error) => {
			step.status = 'fail';
			step.finishedAt = new Date().toISOString();
			step.error = error.message || String(error);
			writeTranscript(options.transcriptPath, chunks);
			writeReport();
			reject(error);
		});
		child.on('exit', (code) => {
			step.exitCode = code;
			step.finishedAt = new Date().toISOString();
			writeTranscript(options.transcriptPath, chunks);
			if (code === 0) {
				step.status = 'pass';
				writeReport();
				resolve();
			} else {
				step.status = 'fail';
				step.error = `${label} exited with code ${code}`;
				writeReport();
				reject(new Error(step.error));
			}
		});
	});
}

function copyIfExists(source, target) {
	if (dryRun) {
		console.log(`Copy ${source} -> ${target}`);
		return Promise.resolve();
	}
	if (fs.existsSync(source) === false) {
		throw new Error(`expected spike result was not written: ${source}`);
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
	return Promise.resolve();
}

function recordArtifact(key, target) {
	report.artifacts[key] = artifactRecord(target);
	writeReport();
}

function artifactRecord(target) {
	return {
		path: target,
		relativePath: relativeToRepo(target)
	};
}

function relativeToRepo(target) {
	const relativePath = isWindowsAbsolute(target)
		? path.win32.relative(repoRoot, target)
		: path.relative(repoRoot, target);
	if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath) || isWindowsAbsolute(relativePath)) {
		return null;
	}
	return relativePath.split(path.sep).join('/').replace(/\\/g, '/');
}

function writeTranscript(target, chunks) {
	if (!target) {
		return;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, Buffer.concat(chunks).toString('utf8'));
}

function writeReport() {
	if (canWriteReport === false) {
		return;
	}
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function writeJson(target, value) {
	if (canWriteReport === false) {
		return;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function publicEnv(commandEnv) {
	const value = commandEnv?.UNITY_CURSOR_TOOLKIT_MCP_PORTS;
	return value ? { UNITY_CURSOR_TOOLKIT_MCP_PORTS: value } : {};
}

function stopWindowsListener(port) {
	const script = [
		`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;`,
		'if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }'
	].join(' ');
	if (dryRun) {
		console.log(`Cleanup listener on ${port}: powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(script)}`);
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], () => resolve());
	});
}

function unityInstallRoot(candidate) {
	if (!candidate) {
		return candidate;
	}
	const normalized = normalizeUserPath(candidate);
	if (/Unity\.exe$/i.test(normalized)) {
		return isWindowsAbsolute(normalized) ? path.win32.dirname(normalized) : path.dirname(normalized);
	}
	return normalized;
}

function normalizeUserPath(candidate) {
	if (isWindowsAbsolute(candidate)) {
		return path.win32.normalize(candidate);
	}
	return path.resolve(candidate);
}

function joinUnder(base, fileName) {
	return isWindowsAbsolute(base) ? path.win32.join(base, fileName) : path.join(base, fileName);
}

function isWindowsAbsolute(candidate) {
	return /^[A-Za-z]:[\\/]/.test(candidate);
}

function commandForPlatform(command) {
	if (process.platform !== 'win32') {
		return command;
	}
	if (command === 'npm' || command === 'npx' || command === 'cursor') {
		return `${command}.cmd`;
	}
	if (command === 'dotnet') {
		return 'dotnet.exe';
	}
	if (command === 'powershell') {
		return 'powershell.exe';
	}
	return command;
}

function formatCommand(command, args, commandEnv) {
	const envPrefix = commandEnv?.UNITY_CURSOR_TOOLKIT_MCP_PORTS
		? `UNITY_CURSOR_TOOLKIT_MCP_PORTS=${commandEnv.UNITY_CURSOR_TOOLKIT_MCP_PORTS} `
		: '';
	return envPrefix + [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value) {
	const text = String(value);
	return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
}

function slugify(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dateStamp() {
	return new Date().toISOString().slice(0, 10);
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
