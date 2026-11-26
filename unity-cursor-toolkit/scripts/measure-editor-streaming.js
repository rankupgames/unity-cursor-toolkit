#!/usr/bin/env node
/**
 * Measures resource cost while a real Unity EditorWindow viewport stream runs.
 *
 * This attaches to an already-running Unity Cursor Toolkit bridge, starts its
 * own Scene View stream session, samples the Unity process, and writes a JSON
 * report. It does not launch Unity or mutate project assets.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const defaultProjectRoot = path.join(repoRoot, 'CursorUnityTool');

const options = {
	durationSeconds: getIntArg('--duration', 60),
	idleSeconds: getIntArg('--idle-seconds', 15),
	fps: getIntArg('--fps', 12),
	quality: getIntArg('--quality', 55),
	view: getStringArg('--view', 'scene'),
	captureMode: getStringArg('--capture-mode', 'editorWindow'),
	out: getStringArg('--out', path.join(os.tmpdir(), 'uct-editor-stream-measure.json')),
	pid: getIntArg('--pid', 0) || null,
	ports: parsePorts(getStringArg('--ports', process.env.UNITY_CURSOR_TOOLKIT_MCP_PORTS || '')),
	project: path.resolve(getStringArg('--project', defaultProjectRoot)),
	sampleOnly: hasFlag('--sample-only'),
	editorVersion: getStringArg('--editor-version', ''),
	requireCoreCLR: hasFlag('--require-coreclr'),
	frameOut: getStringArg('--frame-out', '')
};

const sessionId = `measure_${options.view}_${Date.now()}`;
const measurement = {
	schemaVersion: 1,
	platform: process.platform,
	sessionId,
	port: null,
	pid: options.pid,
	view: options.view,
	captureMode: options.captureMode,
	requestedFps: options.fps,
	quality: options.quality,
	durationSeconds: options.durationSeconds,
	idleSeconds: options.idleSeconds,
	startedAt: new Date().toISOString(),
	mode: options.sampleOnly ? 'sample-only' : 'bridge-stream',
	streamStartedAt: null,
	finishedAt: null,
	firstFrameAt: null,
	frameCount: 0,
	frameDataBytes: [],
	frameSizes: [],
	idleSamples: [],
	streamSamples: [],
	errors: []
};

let socket = null;
let buffer = '';
let phase = 'connect';
let sampleTimer = null;
let finished = false;
let previousCpu = null;
let streamStarted = false;
let collectingFrames = false;
let windowStarted = null;
let requestSequence = 0;
const pending = new Map();
const inflightSamples = new Set();

main().catch(async error => {
	collectingFrames = false;
	await stopSampling();
	try { await stopStream(); } catch (stopError) { recordError(stopError.message); }
	fail(error.message || String(error));
});

async function main() {
	console.log('Unity Cursor Toolkit -- Editor Stream Measurement\n');
	if (!options.sampleOnly && !['scene', 'game', 'inspector', 'packageManager'].includes(options.view) && !/^window:.+/.test(options.view))
		throw new Error('invalid_request: unsupported viewport view');
	console.log(`Ports: ${options.ports.join(', ')}`);
	console.log(`Session: ${sessionId}`);
	console.log(`Output: ${options.out}`);

	if (options.sampleOnly) {
		if (measurement.pid == null) {
			measurement.pid = await findUnityEditorPid(options.project);
		}
		if (measurement.pid == null) {
			throw new Error(`could not resolve Unity PID for project ${options.project}; pass --pid`);
		}

		console.log(`Sample-only mode: sampling PID ${measurement.pid} for ${options.durationSeconds}s.`);
		phase = 'stream';
		measurement.streamStartedAt = new Date().toISOString();
		startSampling();
		await sleep(options.durationSeconds * 1000);
		await stopSampling();
		finish(measurement.errors.length ? 1 : 0);
		return;
	}

	const connected = await connectBridge(options.ports);
	socket = connected.socket;
	measurement.port = connected.port;
	socket.on('data', onData);
	socket.on('error', (error) => recordError(error.message || String(error)));

	const listenerPid = await resolvePidForPort(connected.port);
	if (options.pid && listenerPid !== options.pid) throw new Error('target_mismatch: listener PID differs from requested PID');
	measurement.pid = listenerPid;
	if (measurement.pid == null) {
		throw new Error(`could not resolve Unity PID for port ${connected.port}; pass --pid`);
	}

	console.log(`Connected to bridge on ${connected.port}; sampling PID ${measurement.pid}.`);

	const identity = await request('project_info', {});
	if (typeof identity?.projectPath !== 'string' || !identity.projectPath.trim() || typeof identity.unityVersion !== 'string' || !identity.unityVersion.trim()
		|| (process.platform === 'win32' ? path.resolve(identity.projectPath).toLowerCase() !== options.project.toLowerCase() : path.resolve(identity.projectPath) !== options.project)
		|| (options.editorVersion && identity.unityVersion !== options.editorVersion)
		|| (options.requireCoreCLR && identity.runtime?.isCoreCLR !== true)) throw new Error('target_mismatch: project/version/runtime differs');
	measurement.identity = identity;
	writeMeasurement();

	phase = 'idle';
	if (options.idleSeconds > 0) {
		console.log(`Sampling attached editor idle for ${options.idleSeconds}s...`);
		startSampling();
		await sleep(options.idleSeconds * 1000);
		await stopSampling();
	}

	const existing = readStreamStatus(await request('viewport_stream', { action: 'status' }));
	if (existing.sessions.some(item => item.view === options.view || item.sessionId === sessionId))
		throw new Error('stream_view_occupied: requested view already has a stream; no start or stop sent');

	console.log(`Starting ${options.view} ${options.captureMode} stream at ${options.fps}fps for ${options.durationSeconds}s...`);
	previousCpu = null;
	phase = 'stream';
	measurement.streamStartedAt = new Date().toISOString();
	windowStarted = performance.now();
	collectingFrames = true;
	streamStarted = true;
	const start = await request('viewport_stream', { action: 'start', sessionId, host: 'editor', view: options.view, captureMode: options.captureMode, fps: options.fps, quality: options.quality });
	if (start?.success !== true || start.sessionId !== sessionId) throw new Error('stream_start_failed: ' + JSON.stringify(start));
	startSampling();
	await sleep(options.durationSeconds * 1000);
	collectingFrames = false;
	measurement.streamFinishedAt = new Date().toISOString();
	measurement.elapsedWindowSeconds = Number(((performance.now() - windowStarted) / 1000).toFixed(6));
	await stopSampling();
	await stopStream();
	if (measurement.frameCount === 0) throw new Error('frames_missing: stream produced no frame');
	finish(measurement.errors.length ? 1 : 0);
}

async function connectBridge(ports) {
	for (const port of ports) {
		const connected = await tryConnectPort(port);
		if (connected) {
			return connected;
		}
	}
	throw new Error(`no toolkit bridge answered JSON pong on ports: ${ports.join(', ')}`);
}

function tryConnectPort(port) {
	return new Promise((resolve) => {
		const candidate = net.createConnection({ host: '127.0.0.1', port });
		let localBuffer = '';
		let done = false;
		const timer = setTimeout(() => complete(null), 8000);

		function complete(result) {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			candidate.removeListener('data', onPong);
			if (result == null) {
				candidate.destroy();
			}
			resolve(result);
		}

		candidate.once('connect', () => {
			candidate.write('{"command":"ping"}\n');
		});
		const onPong = (chunk) => {
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
						complete({ socket: candidate, port });
						return;
					}
				} catch {
					// Keep scanning until timeout; non-JSON listeners are rejected.
				}
			}
		};
		candidate.on('data', onPong);
		candidate.once('error', () => complete(null));
	});
}

function onData(chunk) {
	buffer += chunk.toString();
	if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024) { recordError('output_too_large: bridge buffer exceeded8MiB'); socket.destroy(); return; }
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
	if (typeof message.data !== 'string' || !message.data || !Number.isFinite(message.width) || message.width <= 0 || !Number.isFinite(message.height) || message.height <= 0) { recordError('invalid_frame: data or size missing'); return; }
	const bytes = Buffer.from(message.data, 'base64');
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { recordError('invalid_frame: JPEG missing'); return; }
	measurement.frameCount++;
	if (measurement.firstFrameAt == null) {
		measurement.firstFrameAt = new Date().toISOString();
		if (options.frameOut) { fs.mkdirSync(path.dirname(path.resolve(options.frameOut)), { recursive: true }); fs.writeFileSync(options.frameOut, bytes); }
	}
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
	sampleTimer = setInterval(sampleMetrics, 5000);
}

async function stopSampling() {
	if (sampleTimer != null) clearInterval(sampleTimer);
	sampleTimer = null;
	await Promise.allSettled([...inflightSamples]);
}

function sampleMetrics() {
	const samplePhase = phase;
	const task = readProcessMetrics(measurement.pid).then(sample => {
		const at = sample.sampleAt || Date.now();
		delete sample.sampleAt;
		if (process.platform === 'win32' && Number.isFinite(sample.cpuSeconds)) {
			if (previousCpu && at > previousCpu.at)
				sample.cpuPercent = Number(((sample.cpuSeconds - previousCpu.seconds) / ((at - previousCpu.at) / 1000) * 100).toFixed(1));
			previousCpu = { at, seconds: sample.cpuSeconds };
		}
		if (sample.error || !Number.isFinite(sample.rssMb) || !(process.platform === 'win32' ? Number.isFinite(sample.cpuSeconds) : Number.isFinite(sample.cpuPercent))) recordError('metrics_unavailable: ' + (sample.error || 'RSS or CPU missing'));
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
		return execJson('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { missing: 'Unity process not found' });
	}

	return new Promise((resolve) => {
		execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { timeout: 10000 }, (error, stdout) => {
			if (error || !stdout.trim()) {
				resolve({ error: error ? error.message : 'Unity process not found' });
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
		execFile(command, args, { timeout: 10000, windowsHide: true }, (error, stdout) => {
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

async function resolvePidForPort(port) {
	if (process.platform === 'win32') {
		const script = [
			`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;`,
			'if ($c) { $c.OwningProcess }'
		].join(' ');
		const result = await execText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
		const parsed = Number.parseInt(result.trim(), 10);
		return Number.isInteger(parsed) ? parsed : null;
	}

	const result = await execText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
	const parsed = Number.parseInt(result.trim().split(/\s+/)[0], 10);
	return Number.isInteger(parsed) ? parsed : null;
}

async function findUnityEditorPid(projectPath) {
	if (process.platform === 'win32') {
		const escaped = projectPath.replace(/'/g, "''");
		const script = [
			"Get-CimInstance Win32_Process -Filter \"name = 'Unity.exe'\" |",
			`Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.CommandLine -notlike '*AssetImportWorker*' } |`,
			'Select-Object -First 1 -ExpandProperty ProcessId'
		].join(' ');
		const result = await execText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
		const parsed = Number.parseInt(result.trim(), 10);
		return Number.isInteger(parsed) ? parsed : null;
	}

	const result = await execText('ps', ['axo', 'pid=,command=']);
	const projectNeedle = projectPath;
	for (const line of result.split(/\r?\n/)) {
		if (!line.includes('Unity.app/Contents/MacOS/Unity') && !line.includes('/Editor/Unity')) {
			continue;
		}
		if (line.includes('AssetImportWorker')) {
			continue;
		}
		if (!line.includes(projectNeedle)) {
			continue;
		}
		const parsed = Number.parseInt(line.trim().split(/\s+/)[0], 10);
		if (Number.isInteger(parsed)) {
			return parsed;
		}
	}
	return null;
}

function execText(command, args) {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 10000, windowsHide: true }, (error, stdout) => {
			resolve(error ? '' : stdout);
		});
	});
}

function request(toolName, args) {
	const id = 'measure_' + (++requestSequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge_timeout: ' + toolName)); }, 15000);
		pending.set(id, { resolve, reject, timer });
		send({ command: 'mcpToolCall', _requestId: id, toolName, args });
	});
}
function readStreamStatus(value) {
	if (value?.success !== true || !Array.isArray(value.sessions) || !Number.isInteger(value.runningSessions)
		|| value.runningSessions !== value.sessions.length || value.running !== (value.runningSessions > 0)
		|| value.sessions.some(item => !item || typeof item.sessionId !== 'string' || !item.sessionId || typeof item.view !== 'string' || !item.view)
		|| new Set(value.sessions.map(item => item.sessionId)).size !== value.sessions.length
		|| (value.session !== undefined && (!value.session || !value.sessions.some(item => item.sessionId === value.session.sessionId && item.view === value.session.view))))
		throw new Error('stream_status_invalid: expected consistent running/count/session array');
	return value;
}
async function stopStream() {
	if (!streamStarted) return;
	if (!socket || socket.destroyed) throw new Error('stream_stop_unconfirmed: disconnected owned stream');
	const result = await request('viewport_stream', { action: 'stop', sessionId });
	if (result?.success !== true || result.stopped !== 1 || !Number.isInteger(result.runningSessions) || result.runningSessions < 0 || result.running !== (result.runningSessions > 0)) throw new Error('stream_stop_unconfirmed: ' + JSON.stringify(result));
	const status = readStreamStatus(await request('viewport_stream', { action: 'status', sessionId }));
	if (status.session || status.sessions.some(item => item.sessionId === sessionId))
		throw new Error('stream_stop_unconfirmed: session remains');
	streamStarted = false;
}

function send(payload) {
	if (!socket || socket.destroyed) throw new Error('bridge_disconnected');
	socket.write(JSON.stringify(payload) + '\n');
}

function recordError(message) {
	measurement.errors.push({
		at: new Date().toISOString(),
		message
	});
	writeMeasurement();
}

function finish(code) {
	if (finished) {
		return;
	}
	finished = true;
	for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('bridge_closed')); }
	pending.clear();
	measurement.success = code === 0;
	measurement.cpuEstimator = process.platform === 'win32' ? 'interval-process-CPU-seconds / elapsed-seconds * 100 (one-core units)' : 'platform ps percent (macOS decaying average)';
	measurement.rssUnit = 'MiB';
	measurement.frameDataUnit = 'base64 UTF-8 bytes';
	measurement.finishedAt = new Date().toISOString();
	measurement.effectiveFps = Number((measurement.frameCount / Math.max(0.001, measurement.elapsedWindowSeconds || options.durationSeconds)).toFixed(2));
	writeMeasurement();
	try { socket?.end(); } catch {}
	console.log(`Frames: ${measurement.frameCount} (${measurement.effectiveFps} fps effective)`);
	console.log(`Idle samples: ${measurement.idleSamples.length}; stream samples: ${measurement.streamSamples.length}`);
	console.log(`Wrote ${options.out}`);
	process.exitCode = code;
	setTimeout(() => process.exit(code), 250);
}

function fail(message) {
	recordError(message);
	console.error('Measurement failed: ' + message);
	finish(1);
}

function writeMeasurement() {
	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(options.out, JSON.stringify(clean(measurement), null, 2));
}

function clean(value) {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/ownerToken/i.test(key)).map(([key, item]) => [key, clean(item)]));
	if (typeof value !== 'string') return value;
	for (const [location, replacement] of [[options.project, '<owned-project>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']]) {
		if (location) value = value.split(location).join(replacement).split(location.replace(/\\/g, '/')).join(replacement);
	}
	return value.replace(/(?:ownerToken|sessionId|correlationId|machineId|accessToken|authToken)\s*["':=]+\s*["']?[a-z0-9_-]{16,}/gi, '<private-value>')
		.replace(/\b[a-f0-9]{32,}\b/gi, '<nonce>').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePorts(value) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		return [55500, 55501, 55502, 55503, 55504];
	}

	const parsed = value.split(',')
		.map(part => Number.parseInt(part.trim(), 10))
		.filter(port => Number.isInteger(port) && port > 0 && port < 65536);
	return parsed.length === 0 ? [55500, 55501, 55502, 55503, 55504] : parsed;
}

function getIntArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		const value = Number.parseInt(process.argv[index + 1], 10);
		if (Number.isFinite(value)) {
			return value;
		}
	}
	return fallback;
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}
