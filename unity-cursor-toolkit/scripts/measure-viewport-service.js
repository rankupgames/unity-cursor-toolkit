#!/usr/bin/env node
/**
 * Launches a built Viewport Service player, starts one player-hosted viewport
 * stream, samples resource cost, and writes an incremental JSON report.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');

const options = {
	playerPath: path.resolve(getStringArg('--player', defaultPlayerPath())),
	port: getIntArg('--port', 55501),
	width: getIntArg('--width', 1280),
	height: getIntArg('--height', 720),
	fps: getIntArg('--fps', 30),
	quality: getIntArg('--quality', 72),
	view: getStringArg('--view', 'game'),
	durationSeconds: getIntArg('--duration', 30),
	idleSeconds: getIntArg('--idle-seconds', 3),
	timeoutSeconds: getIntArg('--timeout', 45),
	sampleIntervalMs: getIntArg('--sample-interval-ms', 1000),
	out: getStringArg('--out', path.join(os.tmpdir(), 'uct-viewport-service-measure.json')),
	hide: hasFlag('--hide'),
	keepOpen: hasFlag('--keep-open'),
	proofRoot: getStringArg('--proof-root', ''),
	frameOut: getStringArg('--frame-out', '')
};

const sessionId = `player_measure_${options.view}_${Date.now()}`;
const measurement = {
	schemaVersion: 1,
	mode: 'player-viewport-service',
	platform: process.platform,
	arch: process.arch,
	osRelease: os.release(),
	nodeVersion: process.version,
	startedAt: new Date().toISOString(),
	launchStartedAt: null,
	portReadyAt: null,
	streamStartedAt: null,
	firstFrameAt: null,
	lastFrameAt: null,
	finishedAt: null,
	playerPath: options.playerPath,
	playerExecutable: null,
	playerPid: null,
	port: options.port,
	sessionId,
	request: {
		view: options.view,
		host: 'player',
		captureMode: 'camera',
		width: options.width,
		height: options.height,
		fps: options.fps,
		quality: options.quality,
		durationSeconds: options.durationSeconds,
		idleSeconds: options.idleSeconds,
		sampleIntervalMs: options.sampleIntervalMs
	},
	streamStartResult: null,
	frameCount: 0,
	frameDataBytes: [],
	frameSizes: [],
	idleSamples: [],
	streamSamples: [],
	summary: {},
	errors: []
};

let child = null;
let socket = null;
let buffer = '';
let sampleTimer = null;
let phase = 'launch';
let finished = false;
let collectingFrames = false;
let previousCpu = null;
let control = null;
let outcome = null;
let started = false;
let requestSequence = 0;
const pending = new Map();
const inflightSamples = new Set();

process.once('SIGINT', () => finish(130));
process.once('SIGTERM', () => finish(143));

main().catch(async (error) => {
	process.exitCode = 1;
	recordError(error.message || String(error));
	await finish(1);
});

async function main() {
	const executable = resolvePlayerExecutable(options.playerPath);
	if (options.proofRoot) control = prepareControl(executable);
	measurement.playerExecutable = executable;
	measurement.sourceHashes = { sampler: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
	if (control) measurement.sourceHashes.build = JSON.parse(fs.readFileSync(path.join(options.proofRoot, 'proof-build.json'), 'utf8')).sourceHashes;
	if (await listenerPid(options.port) !== null) throw new Error('port_occupied: refuse before player launch');
	measurement.launchStartedAt = new Date().toISOString();
	writeMeasurement();

	console.log('Unity Cursor Toolkit -- Viewport Service Measurement\n');
	console.log(`Player: ${executable}`);
	console.log(`Port:   ${options.port}`);
	console.log(`Stream: ${options.view} ${options.width}x${options.height}@${options.fps}, q${options.quality}`);
	console.log(`Output: ${options.out}`);

	child = spawn(executable, [
		'-uctViewportPort', String(options.port),
		'-screen-width', '320',
		'-screen-height', '200',
		'-screen-fullscreen', '0',
		...(control ? ['-logFile', path.join(control, 'Player.log')] : [])
	], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...process.env, ...(control ? { UCT_PLAYER_PROOF_CONTROL: control } : {}) }
	});
	child.once('exit', (code, signal) => outcome = { code, signal });
	child.once('error', error => { outcome = { code: null, launchFailed: true }; recordError('player_launch_failed: ' + error.message); });
	measurement.playerPid = child.pid;
	writeMeasurement();

	if (options.hide) {
		setTimeout(() => hidePlayer(child.pid), 2000);
		setTimeout(() => hidePlayer(child.pid), 8000);
	}

	await waitForPong(options.port, options.timeoutSeconds * 1000);
	measurement.portReadyAt = new Date().toISOString();
	if (await listenerPid(options.port) !== child.pid) throw new Error('target_mismatch: listener does not belong to launched player');
	if (control) {
		const identity = await waitForIdentity(control);
		const build = JSON.parse(fs.readFileSync(path.join(options.proofRoot, 'proof-build.json'), 'utf8'));
		if (identity.pid !== child.pid || identity.editorVersion !== build.version || identity.coreLibrary !== 'System.Private.CoreLib' || identity.platform !== 'WindowsPlayer' || identity.is64BitProcess !== true || !identity.renderPipeline)
			throw new Error('runtime_identity_invalid: expected exact CoreCLR Windows64 URP player');
		measurement.runtimeIdentity = identity;
	}
	measurement.identityVerifiedAt = new Date().toISOString();
	writeMeasurement();
	console.log('Viewport Service answered toolkit ping.');

	socket = await connectProtocol(options.port);
	socket.on('data', onData);
	socket.on('error', (error) => recordError(error.message || String(error)));

	if (options.idleSeconds > 0) {
		phase = 'idle';
		console.log(`Sampling idle player for ${options.idleSeconds}s...`);
		startSampling();
		await sleep(options.idleSeconds * 1000);
		await stopSampling();
	}

	const status = playerStatus(await request({ action: 'status' }));
	if (status.sessions !== 0) throw new Error('player_busy: owned player must have no pre-existing streams');
	previousCpu = null;
	phase = 'stream';
	measurement.streamStartedAt = new Date().toISOString();
	measurement.windowStartMonotonic = performance.now();
	collectingFrames = true;
	started = true;
	measurement.streamStartResult = await request({ action: 'start', sessionId, host: 'player', view: options.view, captureMode: 'camera',
		width: options.width, height: options.height, fps: options.fps, quality: options.quality });
	if (measurement.streamStartResult?.success !== true || measurement.streamStartResult.host !== 'player' || measurement.streamStartResult.sessionId !== sessionId || measurement.streamStartResult.captureMode !== 'camera')
		throw new Error('stream_start_failed: expected correlated player camera session');
	writeMeasurement();
	startSampling();
	await sleep(options.durationSeconds * 1000);
	collectingFrames = false;
	measurement.streamFinishedAt = new Date().toISOString();
	measurement.elapsedWindowSeconds = (performance.now() - measurement.windowStartMonotonic) / 1000;
	delete measurement.windowStartMonotonic;
	await stopSampling();
	await stopStream();

	if (measurement.frameCount === 0) {
		recordError('no viewportFrame messages were received');
		await finish(1);
		return;
	}

	await finish(0);
}

function waitForPong(targetPort, timeoutMs) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		function attempt() {
			const candidate = net.createConnection({ host: '127.0.0.1', port: targetPort });
			let localBuffer = '';
			let settled = false;
			const timer = setTimeout(() => settle(false), 1200);

			function settle(success) {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				candidate.destroy();
				if (success) {
					resolve();
					return;
				}
				if (Date.now() - started > timeoutMs) {
					reject(new Error(`timed out waiting for Viewport Service on ${targetPort}`));
					return;
				}
				setTimeout(attempt, 500);
			}

			candidate.once('connect', () => candidate.write('{"command":"ping"}\n'));
			candidate.on('data', (chunk) => {
				localBuffer += chunk.toString();
				if (localBuffer.includes('"command":"pong"')) {
					settle(true);
				}
			});
			candidate.once('error', () => settle(false));
		}

		attempt();
	});
}

function connectProtocol(targetPort) {
	return new Promise((resolve, reject) => {
		const candidate = net.createConnection({ host: '127.0.0.1', port: targetPort });
		let localBuffer = '';
		let settled = false;
		const timer = setTimeout(() => fail(new Error(`timed out opening protocol socket on ${targetPort}`)), 5000);

		function fail(error) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			candidate.destroy();
			reject(error);
		}

		function pass() {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			candidate.removeListener('data', onCandidateData);
			resolve(candidate);
		}

		candidate.once('connect', () => candidate.write('{"command":"ping"}\n'));
		candidate.on('data', onCandidateData);
		candidate.once('error', fail);

		function onCandidateData(chunk) {
			localBuffer += chunk.toString();
			let newline;
			while ((newline = localBuffer.indexOf('\n')) >= 0) {
				const line = localBuffer.slice(0, newline).trim();
				localBuffer = localBuffer.slice(newline + 1);
				if (!line) {
					continue;
				}
				try {
					const message = JSON.parse(line);
					if (message.command === 'pong') {
						buffer = localBuffer;
						pass();
						return;
					}
				} catch {
					// Keep scanning until timeout.
				}
			}
		}
	});
}

function onData(chunk) {
	buffer += chunk.toString();
	if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024) { recordError('output_too_large'); socket.destroy(); return; }
	let newline;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line.length === 0) {
			continue;
		}

		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}

		if (message.command === 'mcpToolResult' && pending.has(message._requestId)) {
			const item = pending.get(message._requestId); pending.delete(message._requestId); clearTimeout(item.timer); item.resolve(message.result); continue;
		}

		if (message.command === 'viewportFrame' && message.sessionId === sessionId) {
			recordFrame(message);
		}
	}
}

function recordFrame(message) {
	if (!collectingFrames) return;
	if (message.host !== 'player' || message.captureMode !== 'camera' || message.width !== options.width || message.height !== options.height || typeof message.data !== 'string') { recordError('invalid_frame: expected player camera dimensions/data'); return; }
	const bytes = Buffer.from(message.data, 'base64');
	if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) { recordError('invalid_frame: JPEG missing'); return; }
	const now = new Date().toISOString();
	measurement.frameCount++;
	if (measurement.firstFrameAt == null) {
		measurement.firstFrameAt = now;
		if (options.frameOut) { fs.mkdirSync(path.dirname(path.resolve(options.frameOut)), { recursive: true }); fs.writeFileSync(options.frameOut, bytes); }
	}
	measurement.lastFrameAt = now;
	if (typeof message.data === 'string') {
		measurement.frameDataBytes.push(Buffer.byteLength(message.data, 'utf8'));
	}
	if (Number.isFinite(message.width) && Number.isFinite(message.height)) {
		measurement.frameSizes.push({ width: message.width, height: message.height });
	}
	writeMeasurement();
}

function startSampling() {
	sampleMetrics();
	sampleTimer = setInterval(sampleMetrics, options.sampleIntervalMs);
}

async function stopSampling() {
	if (sampleTimer != null) clearInterval(sampleTimer);
	sampleTimer = null;
	await Promise.allSettled([...inflightSamples]);
}

function sampleMetrics() {
	const samplePhase = phase;
	const task = readProcessMetrics(measurement.playerPid).then(sample => {
		const at = sample.sampleAt || Date.now(); delete sample.sampleAt;
		if (process.platform === 'win32' && Number.isFinite(sample.cpuSeconds)) {
			if (previousCpu && at > previousCpu.at) sample.cpuPercent = (sample.cpuSeconds - previousCpu.seconds) / ((at - previousCpu.at) / 1000) * 100;
			previousCpu = { at, seconds: sample.cpuSeconds };
		}
		if (sample.error || !Number.isFinite(sample.rssMb) || !(process.platform === 'win32' ? Number.isFinite(sample.cpuSeconds) : Number.isFinite(sample.cpuPercent))) recordError('metrics_unavailable: ' + (sample.error || 'RSS/CPU missing'));
		(samplePhase === 'idle' ? measurement.idleSamples : measurement.streamSamples).push({ at: new Date(at).toISOString(), phase: samplePhase, ...sample });
		writeMeasurement();
	}).finally(() => inflightSamples.delete(task));
	inflightSamples.add(task);
}
function readProcessMetrics(pid) {
	if (process.platform === 'win32') {
		const script = [
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
			'if ($p) { [pscustomobject]@{ rssMb = [math]::Round($p.WorkingSet64 / 1MB, 1); cpuSeconds = $p.TotalProcessorTime.TotalSeconds; sampleAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }'
		].join(' ');
		return execJson('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { missing: 'player process not found' });
	}

	return new Promise((resolve) => {
		execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 10000 }, (error, stdout) => {
			if (error || !stdout.trim()) {
				resolve({ error: error ? error.message : 'player process not found' });
				return;
			}
			const parts = stdout.trim().split(/\s+/);
			resolve({
				rssMb: Number((Number(parts[0]) / 1024).toFixed(1)),
				cpuPercent: Number(Number(parts[1]).toFixed(1))
			});
		});
	});
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

function request(args) {
	const id = 'player_measure_' + (++requestSequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge_timeout: ' + args.action)); }, 5000);
		pending.set(id, { resolve, reject, timer });
		send({ command: 'mcpToolCall', _requestId: id, toolName: 'viewport_stream', args });
	});
}
function playerStatus(value) {
	if (value?.success !== true || value.host !== 'player' || !Number.isInteger(value.sessions) || value.sessions < 0) throw new Error('player_status_invalid');
	return value;
}
async function stopStream() {
	if (!started) return;
	if (!socket || socket.destroyed) throw new Error('stream_stop_unconfirmed: disconnected');
	const result = await request({ action: 'stop', sessionId });
	if (result?.success !== true || result.host !== 'player') throw new Error('stream_stop_unconfirmed: no owned stop acknowledgement');
	if (playerStatus(await request({ action: 'status' })).sessions !== 0) throw new Error('stream_stop_unconfirmed: sessions remain');
	started = false;
}

function send(payload) {
	if (!socket || socket.destroyed) throw new Error('bridge_disconnected');
	socket.write(JSON.stringify(payload) + '\n');
}

function summarize() {
	const startupMs = diffMs(measurement.launchStartedAt, measurement.portReadyAt);
	const timeToFirstFrameMs = diffMs(measurement.launchStartedAt, measurement.firstFrameAt);
	const streamStartToFirstFrameMs = diffMs(measurement.streamStartedAt, measurement.firstFrameAt);
	const firstToLastMs = diffMs(measurement.firstFrameAt, measurement.lastFrameAt);
	const frameWindowSeconds = firstToLastMs != null ? firstToLastMs / 1000 : null;
	const effectiveFps = frameWindowSeconds > 0 && measurement.frameCount > 1
		? (measurement.frameCount - 1) / frameWindowSeconds
		: 0;
	const streamWindowFps = measurement.frameCount / Math.max(0.001, measurement.elapsedWindowSeconds || options.durationSeconds);

	measurement.summary = {
		startupMs,
		timeToFirstFrameMs,
		streamStartToFirstFrameMs,
		frameWindowSeconds: round(frameWindowSeconds, 3),
		effectiveFps: round(effectiveFps, 2),
		streamWindowFps: round(streamWindowFps, 2),
		frameDataBytes: summarizeNumbers(measurement.frameDataBytes),
		idle: summarizeSamples(measurement.idleSamples),
		stream: summarizeSamples(measurement.streamSamples)
	};
}

function summarizeNumbers(values) {
	const numeric = values.filter(Number.isFinite);
	if (numeric.length === 0) {
		return { count: 0 };
	}
	const sum = numeric.reduce((total, value) => total + value, 0);
	return {
		count: numeric.length,
		min: Math.min(...numeric),
		avg: round(sum / numeric.length, 1),
		max: Math.max(...numeric)
	};
}

function summarizeSamples(samples) {
	return {
		count: samples.length,
		rssMb: summarizeNumbers(samples.map(sample => sample.rssMb)),
		cpuPercent: summarizeNumbers(samples.map(sample => sample.cpuPercent)),
		cpuSeconds: summarizeNumbers(samples.map(sample => sample.cpuSeconds))
	};
}

function diffMs(startIso, endIso) {
	if (startIso == null || endIso == null) {
		return null;
	}
	const value = new Date(endIso).getTime() - new Date(startIso).getTime();
	return Number.isFinite(value) ? value : null;
}

function round(value, places) {
	if (!Number.isFinite(value)) {
		return value;
	}
	const scale = Math.pow(10, places);
	return Math.round(value * scale) / scale;
}

async function finish(code) {
	if (finished) return;
	finished = true; collectingFrames = false;
	await stopSampling();
	try { await stopStream(); } catch (error) { recordError(error.message); }
	try { socket?.end(); } catch {}
	if (child && !options.keepOpen) {
		if (control && !outcome) {
			fs.writeFileSync(path.join(control, 'stop'), 'normal owned stop');
			for (let i = 0; !outcome && i < 100; i++) await sleep(100);
		}
		if (!outcome) { measurement.forcedCleanup = true; stopPlayer(child.pid); for (let i = 0; !outcome && i < 30; i++) await sleep(100); }
		measurement.processExit = outcome;
		measurement.quittingObserved = !!control && fs.existsSync(path.join(control, 'quitting'));
		try { measurement.listenerPidAfterExit = await listenerPid(options.port); } catch (error) { measurement.listenerPidAfterExit = 'unconfirmed'; recordError(error.message); }
		try { measurement.ownedPidRemaining = child.pid ? pidExists(child.pid) : false; } catch (error) { measurement.ownedPidRemaining = 'unconfirmed'; recordError(error.message); }
		if (!outcome || measurement.listenerPidAfterExit != null || measurement.ownedPidRemaining || (control && (outcome.code !== 0 || !measurement.quittingObserved || measurement.forcedCleanup))) recordError('cleanup_unconfirmed');
	}
	measurement.finishedAt = new Date().toISOString();
	summarize();
	if (control && (![measurement.summary.idle.rssMb.avg, measurement.summary.stream.rssMb.avg, measurement.summary.idle.cpuPercent.avg, measurement.summary.stream.cpuPercent.avg].every(Number.isFinite))) recordError('metrics_incomplete: phase averages unavailable');
	measurement.success = code === 0 && measurement.errors.length === 0 && measurement.frameCount > 0;
	measurement.cpuEstimator = process.platform === 'win32' ? 'interval CPUseconds / elapsedSeconds *100; one-core units' : 'platform ps percent; macOS decaying average';
	measurement.rssUnit = 'MiB';
	if (control && fs.existsSync(path.join(control, 'Player.log'))) fs.writeFileSync(path.join(path.dirname(options.out), 'Player.log'), sanitizeLog(fs.readFileSync(path.join(control, 'Player.log'), 'utf8')));
	writeMeasurement();
	console.log(JSON.stringify({ out: options.out, success: measurement.success, frames: measurement.frameCount, summary: measurement.summary }));
	process.exitCode = measurement.success ? 0 : (code || 1);
	setTimeout(() => process.exit(process.exitCode), 250);
}
function recordError(message) {
	measurement.errors.push({
		at: new Date().toISOString(),
		message
	});
	writeMeasurement();
}

function writeMeasurement() {
	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(options.out, JSON.stringify(clean(measurement), null, 2));
}

function stopPlayer(pid) {
	if (!pid) {
		return;
	}
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return;
	}
	setTimeout(() => {
		try {
			if (!outcome) process.kill(pid, 'SIGKILL');
		} catch {
			// already stopped
		}
	}, 1500);
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
			throw new Error(`player app is missing Contents/MacOS: ${candidate}`);
		}
		const executables = fs.readdirSync(macosDir)
			.map(name => path.join(macosDir, name))
			.filter(file => fs.statSync(file).isFile());
		if (executables.length === 0) {
			throw new Error(`no executable found in ${macosDir}`);
		}
		return executables[0];
	}

	if (!fs.existsSync(candidate)) {
		throw new Error(`player executable not found: ${candidate}`);
	}
	return candidate;
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


function prepareControl(executable) {
	options.proofRoot = path.resolve(options.proofRoot);
	const temp = path.resolve(os.tmpdir()) + path.sep;
	if (!options.proofRoot.startsWith(temp) || !path.basename(options.proofRoot).startsWith('uct-player-proof-')
		|| !path.resolve(executable).startsWith(options.proofRoot + path.sep) || options.keepOpen)
		throw new Error('proof_scope_invalid: exact disposable player required');
	const build = JSON.parse(fs.readFileSync(path.join(options.proofRoot, 'proof-build.json'), 'utf8'));
	if (build.passed !== true || build.build?.backend !== 'CoreCLR' || !/^7000\./.test(build.version))
		throw new Error('build_identity_invalid: successful CoreCLR fixture build required');
	if (options.durationSeconds < 1 || options.durationSeconds > 60 || options.idleSeconds < 0 || options.idleSeconds > 15 || options.timeoutSeconds < 1 || options.timeoutSeconds > 45)
		throw new Error('proof_bounds_invalid: stream1..60s, idle0..15s, startup1..45s');
	const directory = path.join(options.proofRoot, 'measure-' + crypto.randomBytes(6).toString('hex'));
	fs.mkdirSync(directory);
	return directory;
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
	for (const [location, replacement] of [[options.proofRoot, '<owned-project>'], [repoRoot, '<repository>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']])
		if (location) value = value.split(location).join(replacement).split(location.replace(/\\/g, '/')).join(replacement);
	return value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
}
function sanitizeLog(value) {
	let next = false;
	return clean(value).split(/\r?\n/).map(line => {
		if (next) { next = false; return '<private argument omitted>'; }
		if (/-hubSessionId/i.test(line)) next = true;
		const assignment = /^(\s*[A-Z][A-Z0-9_]*=)/.exec(line);
		const prefix = assignment && !/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i.test(line) ? assignment[1] : '';
		return /licens|access.?token|auth.?token|serial.?number|session.?id|correlation.?id|machine.?id|ownerToken|^\s*(?:Id|Product|Type|Expiration|User|Serial|Username|Account|ConnectionId|ConnectionKey|ContinuationId)\s*:/i.test(line)
			? '<private metadata omitted>' : prefix + line.slice(prefix.length).replace(/\b[a-z0-9_-]{32,}\b/gi, '<nonce>').replace(/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i, '<opaque-value>').trimEnd();
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
