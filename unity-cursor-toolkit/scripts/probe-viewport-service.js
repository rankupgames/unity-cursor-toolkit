#!/usr/bin/env node
// Probe the existing player-only viewport protocol; no public schema additions.
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ports = parsePorts(process.env.UNITY_CURSOR_TOOLKIT_MCP_PORTS);
const argument = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const expectedPid = Number(argument('--pid', 0));
const out = argument('--out', '');
const framesDir = argument('--frames-dir', '');
const sceneId = 'player_scene_' + Date.now();
const gameId = 'player_game_' + Date.now();
const pending = new Map(), frames = new Map(), started = new Set();
let socket = null, buffer = '', sequence = 0, connectedPort;
const report = { observedAt: new Date().toISOString(), success: false, frames: {}, errors: [] };

main().catch(error => { console.error(error.message); process.exitCode = 2; });

async function main() {
	try {
		socket = await connect();
		socket.on('data', onData);
		socket.on('error', error => report.errors.push(error.message));
		report.port = connectedPort;
		if (expectedPid && await listenerPid(connectedPort) !== expectedPid) throw new Error('target_mismatch: listenerPID differs');
		if (status(await request({ action: 'status' })).sessions !== 0) throw new Error('player_busy: probe refuses existing streams');
		for (const [id, view] of [[sceneId, 'scene'], [gameId, 'game']]) {
			started.add(id);
			const value = await request({ action: 'start', sessionId: id, host: 'player', view, captureMode: 'camera', width: 640, height: 360, fps: 2, quality: 60 });
			if (value?.success !== true || value.host !== 'player' || value.captureMode !== 'camera' || value.sessionId !== id) throw new Error('stream_start_invalid');
		}
		const input = await request({ action: 'input', sessionId: sceneId, inputType: 'sceneDrag', x: 160, y: 140, x2: 240, y2: 180 });
		if (input?.success !== true || input.layer !== 'runtime') throw new Error('input_failed');
		report.runtimeInput = true;
		for (let i = 0; frames.size < 2 && i < 100; i++) await new Promise(r => setTimeout(r, 100));
		if (frames.size !== 2) throw new Error('frames_missing: valid scene+gameJPEG required');
	} catch (error) { report.errors.push(error.message); }
	finally {
		if (socket && !socket.destroyed && started.size) {
			try {
				for (const id of started) {
					const result = await request({ action: 'stop', sessionId: id });
					if (result?.success !== true || result.host !== 'player') throw new Error('stream_stop_unconfirmed');
				}
				if (status(await request({ action: 'status' })).sessions !== 0) throw new Error('stream_stop_unconfirmed: sessions remain');
				report.sessionsStopped = true;
			} catch (error) { report.errors.push(error.message); }
		} else if (started.size) report.errors.push('stream_stop_unconfirmed: disconnected');
		for (const [id, frame] of frames) {
			const name = id === sceneId ? 'scene' : 'game';
			report.frames[name] = { width: frame.width, height: frame.height, host: frame.host, captureMode: frame.captureMode, sequence: frame.sequence, dataBytes: frame.bytes.length };
			if (framesDir) { fs.mkdirSync(framesDir, { recursive: true }); fs.writeFileSync(path.join(framesDir, name + '.jpg'), frame.bytes); }
		}
		report.success = report.errors.length === 0 && frames.size === 2 && report.runtimeInput && report.sessionsStopped;
		if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(clean(report), null, 2) + '\n'); }
		socket?.destroy();
		console.log(JSON.stringify(clean(report)));
		process.exitCode = report.success ? 0 : 2;
	}
}
function request(args) {
	const id = 'player_probe_' + (++sequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge_timeout: ' + args.action)); }, 5000);
		pending.set(id, { resolve, reject, timer });
		if (!socket || socket.destroyed) { clearTimeout(timer); pending.delete(id); reject(new Error('bridge_disconnected')); return; }
		socket.write(JSON.stringify({ command: 'mcpToolCall', _requestId: id, toolName: 'viewport_stream', args }) + '\n');
	});
}
function status(value) {
	if (value?.success !== true || value.host !== 'player' || !Number.isInteger(value.sessions) || value.sessions < 0) throw new Error('player_status_invalid');
	return value;
}
function onData(chunk) {
	buffer += chunk.toString();
	if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024) { report.errors.push('output_too_large'); socket.destroy(); return; }
	let index;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
		let value; try { value = JSON.parse(line); } catch { continue; }
		if (value.command === 'mcpToolResult' && pending.has(value._requestId)) {
			const item = pending.get(value._requestId); pending.delete(value._requestId); clearTimeout(item.timer); item.resolve(value.result);
		} else if (value.command === 'viewportFrame' && [sceneId, gameId].includes(value.sessionId) && !frames.has(value.sessionId)) {
			const bytes = typeof value.data === 'string' ? Buffer.from(value.data, 'base64') : Buffer.alloc(0);
			if (value.host !== 'player' || value.captureMode !== 'camera' || value.width !== 640 || value.height !== 360 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) { report.errors.push('invalid_frame'); continue; }
			frames.set(value.sessionId, { ...value, bytes });
		}
	}
}
async function connect() {
	for (const port of ports) {
		const result = await new Promise(resolve => {
			const candidate = net.createConnection({ host: '127.0.0.1', port });
			let data = '', settled = false;
			const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); candidate.removeAllListeners('data'); candidate.removeAllListeners('error'); if (!ok) candidate.destroy(); resolve(ok ? candidate : null); };
			const timer = setTimeout(() => finish(false), 2500);
			candidate.once('connect', () => candidate.write('{"command":"ping"}\n'));
			candidate.on('data', chunk => { data += chunk.toString(); if (Buffer.byteLength(data, 'utf8') > 8 * 1024 * 1024) { finish(false); return; } for (const line of data.split('\n').slice(0, -1)) { try { if (JSON.parse(line).command === 'pong') finish(true); } catch {} } });
			candidate.once('error', () => finish(false));
		});
		if (result) { connectedPort = port; return result; }
	}
	throw new Error('player_unavailable: no JSONpong');
}
function parsePorts(value) {
	if (!value) return [55500, 55501, 55502, 55503, 55504];
	const ports = value.split(',').map(Number);
	if (!ports.length || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('invalid_ports');
	return ports;
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

function clean(value) {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)]));
	if (typeof value !== 'string') return value;
	for (const location of [os.homedir(), os.hostname()]) value = value.split(location).join('<private-host>');
	return value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>').replace(/\b[a-f0-9]{32,}\b/gi, '<nonce>');
}
