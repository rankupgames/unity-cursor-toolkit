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
	keepOpen: hasFlag('--keep-open')
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

process.once('SIGINT', () => finish(130));
process.once('SIGTERM', () => finish(143));

main().catch((error) => {
	recordError(error.message || String(error));
	finish(1);
});

async function main() {
	const executable = resolvePlayerExecutable(options.playerPath);
	measurement.playerExecutable = executable;
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
		'-screen-fullscreen', '0'
	], {
		detached: true,
		stdio: 'ignore'
	});
	child.unref();
	measurement.playerPid = child.pid;
	writeMeasurement();

	if (options.hide) {
		setTimeout(() => hidePlayer(child.pid), 2000);
		setTimeout(() => hidePlayer(child.pid), 8000);
	}

	await waitForPong(options.port, options.timeoutSeconds * 1000);
	measurement.portReadyAt = new Date().toISOString();
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
		stopSampling();
	}

	phase = 'stream';
	measurement.streamStartedAt = new Date().toISOString();
	writeMeasurement();
	console.log(`Streaming for ${options.durationSeconds}s...`);
	send({
		command: 'mcpToolCall',
		_requestId: 'measure_start',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId,
			host: 'player',
			view: options.view,
			captureMode: 'camera',
			width: options.width,
			height: options.height,
			fps: options.fps,
			quality: options.quality
		}
	});

	startSampling();
	await sleep(options.durationSeconds * 1000);
	stopSampling();
	await stopStream();

	if (measurement.frameCount === 0) {
		recordError('no viewportFrame messages were received');
		finish(1);
		return;
	}

	finish(0);
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

		if (message.command === 'mcpToolResult' && message._requestId === 'measure_start') {
			measurement.streamStartResult = message.result || message;
			if (message.result?.success !== true) {
				recordError('viewport_stream start failed: ' + JSON.stringify(message.result || message));
			}
			writeMeasurement();
			continue;
		}

		if (message.command === 'viewportFrame' && message.sessionId === sessionId) {
			recordFrame(message);
		}
	}
}

function recordFrame(message) {
	const now = new Date().toISOString();
	measurement.frameCount++;
	if (measurement.firstFrameAt == null) {
		measurement.firstFrameAt = now;
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

function stopSampling() {
	if (sampleTimer != null) {
		clearInterval(sampleTimer);
		sampleTimer = null;
	}
}

async function sampleMetrics() {
	const sample = await readProcessMetrics(measurement.playerPid);
	const target = phase === 'idle' ? measurement.idleSamples : measurement.streamSamples;
	target.push(Object.assign({
		at: new Date().toISOString(),
		phase
	}, sample));
	writeMeasurement();
}

function readProcessMetrics(pid) {
	if (process.platform === 'win32') {
		const script = [
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
			'if ($p) { [pscustomobject]@{ rssMb = [math]::Round($p.WorkingSet64 / 1MB, 1); cpuSeconds = [math]::Round($p.CPU, 3) } | ConvertTo-Json -Compress }'
		].join(' ');
		return execJson('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { missing: 'player process not found' });
	}

	return new Promise((resolve) => {
		execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], (error, stdout) => {
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
		execFile(command, args, (error, stdout) => {
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

function stopStream() {
	return new Promise((resolve) => {
		try {
			send({
				command: 'mcpToolCall',
				_requestId: 'measure_stop',
				toolName: 'viewport_stream',
				args: {
					action: 'stop',
					sessionId,
					view: options.view
				}
			});
		} catch {
			// best effort
		}
		setTimeout(resolve, 500);
	});
}

function send(payload) {
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
	const streamWindowFps = measurement.frameCount / Math.max(1, options.durationSeconds);

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

function finish(code) {
	if (finished) {
		return;
	}
	finished = true;
	stopSampling();
	measurement.finishedAt = new Date().toISOString();
	summarize();
	writeMeasurement();
	try { socket?.end(); } catch {}
	if (child && options.keepOpen === false) {
		stopPlayer(child.pid);
	}
	console.log(`Frames: ${measurement.frameCount} (${measurement.summary.effectiveFps || 0} fps effective)`);
	console.log(`Startup: ${measurement.summary.startupMs == null ? 'n/a' : `${measurement.summary.startupMs} ms`}`);
	console.log(`First frame: ${measurement.summary.timeToFirstFrameMs == null ? 'n/a' : `${measurement.summary.timeToFirstFrameMs} ms from launch`}`);
	console.log(`Wrote ${options.out}`);
	process.exitCode = code;
	setTimeout(() => process.exit(code), child && options.keepOpen === false ? 2200 : 500);
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
	fs.writeFileSync(options.out, JSON.stringify(measurement, null, 2));
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
			process.kill(pid, 'SIGKILL');
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
