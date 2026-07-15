#!/usr/bin/env node
/**
 * Launches a built Viewport Service player and waits for the toolkit protocol.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const playerPath = path.resolve(getStringArg('--player', defaultPlayerPath()));
const port = getIntArg('--port', 55500);
const width = getIntArg('--width', 320);
const height = getIntArg('--height', 200);
const hide = hasFlag('--hide');
const keepOpen = hasFlag('--keep-open');
const timeoutSeconds = getIntArg('--timeout', 30);

let child = null;

main().catch((error) => {
	console.error('Viewport Service failed: ' + (error.message || String(error)));
	if (child && keepOpen === false) {
		try { child.kill(); } catch {}
	}
	process.exitCode = 1;
});

async function main() {
	const executable = resolvePlayerExecutable(playerPath);
	const args = [
		'-uctViewportPort', String(port),
		'-screen-width', String(width),
		'-screen-height', String(height),
		'-screen-fullscreen', '0'
	];

	console.log('Unity Cursor Toolkit -- Run Viewport Service\n');
	console.log(`Player: ${executable}`);
	console.log(`Port:   ${port}`);

	child = spawn(executable, args, {
		detached: true,
		stdio: 'ignore'
	});
	child.unref();

	if (hide) {
		setTimeout(() => hidePlayer(child.pid), 2000);
		setTimeout(() => hidePlayer(child.pid), 8000);
	}

	await waitForPong(port, timeoutSeconds * 1000);
	console.log(`Viewport Service is answering toolkit ping on 127.0.0.1:${port}.`);
	console.log('Attach Cursor with Unity Toolkit: open Player Scene/Game View, then Connect and Start.');
	console.log('Direct probe example: npm --prefix unity-cursor-toolkit run probe:viewport-service');

	if (keepOpen === false) {
		console.log('Player left running for Cursor attachment. Stop it manually when finished.');
	}
}

function defaultPlayerPath() {
	const root = path.join(repoRoot, 'CursorUnityTool', 'Builds', 'ViewportService');
	if (process.platform === 'darwin') {
		return path.join(root, 'ViewportService.app');
	}
	if (process.platform === 'win32') {
		return path.join(root, 'ViewportService.exe');
	}
	return path.join(root, 'ViewportService');
}

function resolvePlayerExecutable(candidate) {
	if (process.platform === 'darwin' && candidate.endsWith('.app')) {
		const macosDir = path.join(candidate, 'Contents', 'MacOS');
		if (!fs.existsSync(macosDir)) {
			throw new Error(`Player app is missing Contents/MacOS: ${candidate}`);
		}
		const executables = fs.readdirSync(macosDir)
			.map(name => path.join(macosDir, name))
			.filter(file => fs.statSync(file).isFile());
		if (executables.length === 0) {
			throw new Error(`No executable found in ${macosDir}`);
		}
		return executables[0];
	}

	if (!fs.existsSync(candidate)) {
		throw new Error(`Player executable not found: ${candidate}`);
	}
	return candidate;
}

function waitForPong(targetPort, timeoutMs) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		function attempt() {
			const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
			let buffer = '';
			let settled = false;
			const timer = setTimeout(() => settle(false), 1200);

			function settle(success) {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (success) {
					resolve();
					return;
				}
				if (Date.now() - started > timeoutMs) {
					reject(new Error(`Timed out waiting for Viewport Service on ${targetPort}`));
					return;
				}
				setTimeout(attempt, 500);
			}

			socket.once('connect', () => socket.write('{"command":"ping"}\n'));
			socket.on('data', chunk => {
				buffer += chunk.toString();
				if (buffer.includes('"command":"pong"')) {
					settle(true);
				}
			});
			socket.once('error', () => settle(false));
		}

		attempt();
	});
}

function hidePlayer(pid) {
	if (process.platform === 'darwin') {
		execFile('osascript', ['-e', `tell application "System Events" to set visible of every process whose unix id is ${pid} to false`], () => {});
		return;
	}
	if (process.platform === 'win32') {
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
