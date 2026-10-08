#!/usr/bin/env node
/**
 * Launches a built Viewport Service player and waits for the toolkit protocol.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const playerPath = path.resolve(getStringArg('--player', defaultPlayerPath()));
const port = getIntArg('--port', 55500);
const width = getIntArg('--width', 320);
const height = getIntArg('--height', 200);
const hide = hasFlag('--hide');
const keepOpen = hasFlag('--keep-open');
const timeoutSeconds = getIntArg('--timeout', 30);
const proofRoot = getStringArg('--proof-root', '');

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
	if (proofRoot) { await runProof(executable); return; }
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

async function runProof(executable) {
	const root = path.resolve(proofRoot);
	if (process.platform !== 'win32' || !root.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('uct-player-proof-') || !path.resolve(executable).startsWith(root + path.sep) || keepOpen)
		throw new Error('proof_scope_invalid');
	const build = JSON.parse(fs.readFileSync(path.join(root, 'proof-build.json'), 'utf8'));
	if (build.passed !== true || build.build?.backend !== 'CoreCLR') throw new Error('build_identity_invalid');
	if (await listenerPid(port) !== null) throw new Error('port_occupied: refuse before owned launch');
	const control = path.join(root, 'probe-' + crypto.randomBytes(6).toString('hex')); fs.mkdirSync(control);
	const out = path.resolve(getStringArg('--out', path.join(root, 'probe-result.json')));
	const frames = path.join(path.dirname(out), 'probe-frames');
	const report = { observedAt: new Date().toISOString(), passed: false, port, errors: [], launchStartedAt: new Date().toISOString(),
		sourceHashes: { run: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), probe: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'probe-viewport-service.js'))).digest('hex'), build: build.sourceHashes } };
	let outcome = null;
	child = spawn(executable, ['-uctViewportPort', String(port), '-screen-width', '320', '-screen-height', '200', '-screen-fullscreen', '0', '-logFile', path.join(control, 'Player.log')],
		{ stdio: 'ignore', windowsHide: true, env: { ...process.env, UCT_PLAYER_PROOF_CONTROL: control } });
	report.pid = child.pid;
	child.once('exit', (code, signal) => outcome = { code, signal });
	child.once('error', error => { outcome = { code: null, launchFailed: true }; report.errors.push('player_launch_failed: ' + error.message); });
	try {
		await waitForPong(port, timeoutSeconds * 1000);
		report.portReadyAt = new Date().toISOString();
		if (await listenerPid(port) !== child.pid) throw new Error('target_mismatch');
		const identity = await waitForIdentity(control);
		if (identity.pid !== child.pid || identity.editorVersion !== build.version || identity.coreLibrary !== 'System.Private.CoreLib' || identity.platform !== 'WindowsPlayer' || identity.is64BitProcess !== true || !identity.renderPipeline) throw new Error('runtime_identity_invalid');
		report.identity = identity; report.identityVerifiedAt = new Date().toISOString();
		const probe = spawn(process.execPath, [path.join(__dirname, 'probe-viewport-service.js'), '--pid', String(child.pid), '--out', out + '.probe.json', '--frames-dir', frames],
			{ windowsHide: true, stdio: 'ignore', env: { ...process.env, UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(port) } });
		const code = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { probe.kill(); reject(new Error('probe_timeout')); }, 40000);
			probe.once('error', error => { clearTimeout(timer); reject(error); });
			probe.once('exit', code => { clearTimeout(timer); resolve(code); });
		});
		if (code !== 0) throw new Error('probe_failed');
		report.probe = JSON.parse(fs.readFileSync(out + '.probe.json', 'utf8'));
	} catch (error) { report.errors.push(error.message); }
	finally {
		if (!outcome) { fs.writeFileSync(path.join(control, 'stop'), 'normal owned stop'); for (let i = 0; !outcome && i < 100; i++) await new Promise(r => setTimeout(r, 100)); }
		if (!outcome) { report.forcedCleanup = true; child.kill(); for (let i = 0; !outcome && i < 30; i++) await new Promise(r => setTimeout(r, 100)); }
		report.outcome = outcome;
		report.quittingObserved = fs.existsSync(path.join(control, 'quitting'));
		try { report.listenerPidAfterExit = await listenerPid(port); } catch (error) { report.listenerPidAfterExit = 'unconfirmed'; report.errors.push(error.message); }
		try { report.ownedPidRemaining = child.pid ? pidExists(child.pid) : false; } catch (error) { report.ownedPidRemaining = 'unconfirmed'; report.errors.push(error.message); }
		report.passed = !report.errors.length && !report.forcedCleanup && report.probe?.success === true && outcome?.code === 0 && report.quittingObserved && !report.ownedPidRemaining && report.listenerPidAfterExit === null;
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, JSON.stringify(clean(report), null, 2) + '\n');
		if (fs.existsSync(path.join(control, 'Player.log'))) fs.writeFileSync(path.join(path.dirname(out), 'probe-Player.log'), sanitizeLog(fs.readFileSync(path.join(control, 'Player.log'), 'utf8')));
		console.log(JSON.stringify({ out, passed: report.passed, pid: child.pid }));
		if (!report.passed) process.exitCode = 1;
	}
}
function execJson(command, args, fallback) {
	return new Promise((resolve) => {
		execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
			if (error || !stdout.trim()) {
				resolve({ error: error ? error.message : fallback.missing });
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (parseError) {
				resolve({ error: parseError.message || String(parseError) });
			}
		});
	});
}

async function listenerPid(port) {
	if (process.platform === 'win32') {
		const result = await execJson('powershell.exe', ['-NoProfile', '-Command',
			'[pscustomobject]@{pids=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ' + port + ' | Select-Object -ExpandProperty OwningProcess -Unique)} | ConvertTo-Json -Compress'], { missing: 'listener query failed' });
		if (result.error || !Array.isArray(result.pids) || result.pids.some(id => !Number.isInteger(id)) || result.pids.length > 1) throw new Error('listener_identity_unavailable');
		return result.pids.length === 1 ? result.pids[0] : null;
	}
	return new Promise((resolve, reject) => execFile('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { timeout: 10000 }, (error, stdout) => {
		if (error && error.code !== 1) { reject(new Error('listener_identity_unavailable')); return; }
		const ids = [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
		if (ids.length > 1 || ids.some(id => !Number.isInteger(id))) reject(new Error('listener_identity_unavailable')); else resolve(ids[0] || null);
	}));
}
function pidExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function clean(value) {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
	if (typeof value !== 'string') return value;
	for (const [location, replacement] of [[proofRoot, '<owned-project>'], [repoRoot, '<repository>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']])
		if (location) value = value.split(location).join(replacement).split(location.replace(/\\/g, '/')).join(replacement);
	return value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
}
function sanitizeLog(value) {
	let next = false;
	return clean(value).split(/\r?\n/).map(line => {
		if (next) { next = false; return '<private argument omitted>'; }
		if (/-hubSessionId/i.test(line)) next = true;
		return /licens|access.?token|auth.?token|serial.?number|session.?id|correlation.?id|machine.?id|ownerToken|^\s*(?:Id|Product|Type|Expiration|User|Serial|Username|Account|ConnectionId|ConnectionKey|ContinuationId)\s*:/i.test(line)
			? '<private metadata omitted>' : line.replace(/\b[a-z0-9_-]{32,}\b/gi, '<nonce>').replace(/^\s*[a-z0-9+/=_-]{24,}\s*$/i, '<opaque-value>').trimEnd();
	}).join('\n');
}

async function waitForIdentity(directory) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try { return JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('runtime_identity_unavailable: identity not published within 5 seconds');
}
