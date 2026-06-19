#!/usr/bin/env node
/**
 * Builds the runtime Viewport Service player using the installed Unity Editor.
 *
 * This is licensed editor usage for the build step only. The resulting player
 * can run without an editor process or editor seat at runtime.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const projectRoot = path.resolve(getStringArg('--project', path.join(repoRoot, 'CursorUnityTool')));
const outputPath = path.resolve(getStringArg('--out', defaultOutputPath()));
const unityPath = resolveUnityPath();
const target = getStringArg('--target', process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const timeoutSeconds = getIntArg('--timeout', 900);
const force = hasFlag('--force');
const logPath = path.join(os.tmpdir(), 'uct-build-viewport-service.log');

main();

function main() {
	const lockPath = path.join(projectRoot, 'Temp', 'UnityLockfile');
	if (fs.existsSync(lockPath) && force === false) {
		console.error('Project lock is held: ' + lockPath);
		console.error('Close Unity first, or pass --force only if the lock is stale.');
		process.exit(1);
	}

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });

	const args = [
		'-batchmode',
		'-quit',
		'-projectPath', projectRoot,
		'-executeMethod', 'UnityCursorToolkit.ViewportServiceBuild.BuildFromCommandLine',
		'-uctViewportBuildPath', outputPath,
		'-uctViewportBuildTarget', target,
		'-silent-crashes',
		'-logFile', logPath
	];

	console.log('Unity Cursor Toolkit -- Build Viewport Service\n');
	console.log(`Unity:  ${unityPath}`);
	console.log(`Project: ${projectRoot}`);
	console.log(`Target:  ${target}`);
	console.log(`Output:  ${outputPath}`);
	console.log(`Log:     ${logPath}\n`);

	const child = spawn(unityPath, args, { stdio: 'inherit' });
	const timer = setTimeout(() => {
		console.error(`Timed out after ${timeoutSeconds}s building Viewport Service.`);
		try { child.kill(); } catch {}
		process.exitCode = 1;
	}, timeoutSeconds * 1000);

	child.on('error', (error) => {
		clearTimeout(timer);
		console.error('Failed to launch Unity: ' + (error.message || String(error)));
		process.exitCode = 1;
	});

	child.on('exit', (code) => {
		clearTimeout(timer);
		if (code === 0) {
			console.log('\nViewport Service build finished.');
			console.log(`Run it with: npm --prefix unity-cursor-toolkit run run:viewport-service -- --player "${outputPath}"`);
		} else {
			console.error(`\nViewport Service build failed with code ${code}. Log: ${logPath}`);
		}
		process.exitCode = code == null ? 1 : code;
	});
}

function defaultOutputPath() {
	const root = path.join(repoRoot, 'CursorUnityTool', 'Builds', 'ViewportService');
	if (process.platform === 'darwin') {
		return path.join(root, 'ViewportService.app');
	}
	if (process.platform === 'win32') {
		return path.join(root, 'ViewportService.exe');
	}
	return path.join(root, 'ViewportService');
}

function resolveUnityPath() {
	const override = process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH || getStringArg('--unity-path', '');
	for (const candidate of expandUnityPath(override)) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	const versionText = fs.readFileSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
	const versionMatch = /^m_EditorVersion:\s*(.+)$/m.exec(versionText);
	const version = versionMatch && versionMatch[1].trim();
	const candidates = process.platform === 'darwin'
		? [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`]
		: process.platform === 'win32'
			? [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`]
			: [`/opt/Unity/Hub/Editor/${version}/Editor/Unity`];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error('Unity executable not found. Set --unity-path or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
}

function expandUnityPath(candidate) {
	if (!candidate) {
		return [];
	}

	const trimmed = candidate.trim();
	if (process.platform === 'darwin' && trimmed.endsWith('.app')) {
		return [path.join(trimmed, 'Contents', 'MacOS', 'Unity'), trimmed];
	}
	if (process.platform === 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity.exe'), trimmed];
	}
	return [trimmed];
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
