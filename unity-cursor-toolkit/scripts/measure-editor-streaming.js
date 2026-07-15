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
	sampleOnly: hasFlag('--sample-only')
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

main().catch((error) => fail(error.message || String(error)));

async function main() {
	console.log('Unity Cursor Toolkit -- Editor Stream Measurement\n');
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
		stopSampling();
		finish(0);
		return;
	}

	const connected = await connectBridge(options.ports);
	socket = connected.socket;
	measurement.port = connected.port;
	socket.on('data', onData);
	socket.on('error', (error) => recordError(error.message || String(error)));

	if (measurement.pid == null) {
		measurement.pid = await resolvePidForPort(connected.port);
	}
	if (measurement.pid == null) {
		throw new Error(`could not resolve Unity PID for port ${connected.port}; pass --pid`);
	}

	console.log(`Connected to bridge on ${connected.port}; sampling PID ${measurement.pid}.`);
	writeMeasurement();

	phase = 'idle';
	if (options.idleSeconds > 0) {
		console.log(`Sampling attached editor idle for ${options.idleSeconds}s...`);
		startSampling();
		await sleep(options.idleSeconds * 1000);
		stopSampling();
	}

	console.log(`Starting ${options.view} ${options.captureMode} stream at ${options.fps}fps for ${options.durationSeconds}s...`);
	phase = 'stream';
	measurement.streamStartedAt = new Date().toISOString();
	send({
		command: 'mcpToolCall',
		_requestId: 'measure_start',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId,
			host: 'editor',
			view: options.view,
			captureMode: options.captureMode,
			fps: options.fps,
			quality: options.quality
		}
	});

	startSampling();
	await sleep(options.durationSeconds * 1000);
	stopSampling();
	await stopStream();
	finish(0);
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
			if (result == null) {
				candidate.destroy();
			}
			resolve(result);
		}

		candidate.once('connect', () => {
			candidate.write('{"command":"ping"}\n');
		});
		candidate.on('data', (chunk) => {
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
		});
		candidate.once('error', () => complete(null));
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
			if (message.result?.success !== true) {
				recordError('viewport_stream start failed: ' + JSON.stringify(message.result || message));
			}
			continue;
		}

		if (message.command === 'viewportFrame' && message.sessionId === sessionId) {
			recordFrame(message);
		}
	}
}

function recordFrame(message) {
	measurement.frameCount++;
	if (measurement.firstFrameAt == null) {
		measurement.firstFrameAt = new Date().toISOString();
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

function stopSampling() {
	if (sampleTimer != null) {
		clearInterval(sampleTimer);
		sampleTimer = null;
	}
}

async function sampleMetrics() {
	const sample = await readProcessMetrics(measurement.pid);
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
		return execJson('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { missing: 'Unity process not found' });
	}

	return new Promise((resolve) => {
		execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], (error, stdout) => {
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
		execFile(command, args, (error, stdout) => {
			resolve(error ? '' : stdout);
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
	measurement.finishedAt = new Date().toISOString();
	measurement.effectiveFps = Number((measurement.frameCount / Math.max(1, options.durationSeconds)).toFixed(2));
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
	fs.writeFileSync(options.out, JSON.stringify(measurement, null, 2));
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
