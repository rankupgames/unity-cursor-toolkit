#!/usr/bin/env node
/**
 * Probes a running Viewport Service player for the toolkit JSON subset.
 */

const net = require('net');

const ports = parsePorts(process.env.UNITY_CURSOR_TOOLKIT_MCP_PORTS);
const sceneSessionId = `player_scene_${Date.now()}`;
const gameSessionId = `player_game_${Date.now()}`;

let socket = null;
let buffer = '';
let connectedPort = null;
let sceneStarted = false;
let gameStarted = false;
let inputOk = false;
let sceneFrame = null;
let gameFrame = null;
let finished = false;

connectPort(0);

setTimeout(() => {
	fail('Timed out waiting for Viewport Service evidence.');
}, 30_000);

function connectPort(index) {
	if (index >= ports.length) {
		fail(`No Viewport Service answered toolkit JSON pong on ports: ${ports.join(', ')}`);
		return;
	}

	const port = ports[index];
	const candidate = net.createConnection({ host: '127.0.0.1', port });
	let localBuffer = '';
	const timer = setTimeout(() => {
		candidate.destroy();
		connectPort(index + 1);
	}, 2500);

	candidate.once('connect', () => {
		candidate.write('{"command":"ping"}\n');
	});

	candidate.on('data', (chunk) => {
		localBuffer += chunk.toString();
		const lines = localBuffer.split('\n');
		localBuffer = lines.pop() || '';
		for (const line of lines) {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.command === 'pong') {
				clearTimeout(timer);
				socket = candidate;
				connectedPort = port;
				socket.on('data', onData);
				socket.on('error', (error) => fail(error.message || String(error)));
				console.log(`Connected to Viewport Service on ${port}.`);
				startProbe();
				return;
			}
		}
	});

	candidate.once('error', () => {
		clearTimeout(timer);
		connectPort(index + 1);
	});
}

function startProbe() {
	send({
		command: 'mcpToolCall',
		_requestId: 'start_scene',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: sceneSessionId,
			host: 'player',
			view: 'scene',
			captureMode: 'camera',
			width: 640,
			height: 360,
			fps: 2,
			quality: 60
		}
	});
	send({
		command: 'mcpToolCall',
		_requestId: 'start_game',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: gameSessionId,
			host: 'player',
			view: 'game',
			captureMode: 'camera',
			width: 640,
			height: 360,
			fps: 2,
			quality: 60
		}
	});
}

function onData(chunk) {
	buffer += chunk.toString();
	const lines = buffer.split('\n');
	buffer = lines.pop() || '';
	for (const line of lines) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		handleMessage(message);
	}
}

function handleMessage(message) {
	if (message.command === 'mcpToolResult' && message._requestId === 'start_scene') {
		sceneStarted = message.result?.success === true && message.result?.host === 'player';
		send({
			command: 'mcpToolCall',
			_requestId: 'scene_input',
			toolName: 'viewport_stream',
			args: {
				action: 'input',
				sessionId: sceneSessionId,
				view: 'scene',
				inputType: 'sceneDrag',
				x: 160,
				y: 140,
				x2: 240,
				y2: 180
			}
		});
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'start_game') {
		gameStarted = message.result?.success === true && message.result?.host === 'player';
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'scene_input') {
		inputOk = message.result?.success === true && message.result?.layer === 'runtime';
		maybeFinish();
		return;
	}

	if (message.command === 'viewportFrame' && message.sessionId === sceneSessionId) {
		sceneFrame = summarizeFrame(message);
		maybeFinish();
		return;
	}

	if (message.command === 'viewportFrame' && message.sessionId === gameSessionId) {
		gameFrame = summarizeFrame(message);
		maybeFinish();
	}
}

function maybeFinish() {
	if (!sceneStarted || !gameStarted || !inputOk || !sceneFrame || !gameFrame) {
		return;
	}

	const success = sceneFrame.host === 'player'
		&& sceneFrame.captureMode === 'camera'
		&& sceneFrame.hasData
		&& gameFrame.host === 'player'
		&& gameFrame.captureMode === 'camera'
		&& gameFrame.hasData;

	if (!success) {
		fail('Probe completed but did not prove in-band player frames.');
		return;
	}

	console.log('Scene frame:', JSON.stringify(sceneFrame));
	console.log('Game frame: ', JSON.stringify(gameFrame));
	console.log('Scene input routed through runtime layer.');
	stopAndExit(0);
}

function summarizeFrame(message) {
	return {
		sequence: message.sequence,
		width: message.width,
		height: message.height,
		host: message.host,
		captureMode: message.captureMode,
		hasData: typeof message.data === 'string' && message.data.length > 32,
		dataLength: typeof message.data === 'string' ? message.data.length : 0
	};
}

function send(payload) {
	socket.write(JSON.stringify(payload) + '\n');
}

function fail(message) {
	if (finished) {
		return;
	}
	console.error(`Viewport Service probe failed: ${message}`);
	stopAndExit(2);
}

function stopAndExit(code) {
	if (finished) {
		return;
	}
	finished = true;
	if (socket && connectedPort != null) {
		try {
			send({ command: 'mcpToolCall', _requestId: 'stop_scene', toolName: 'viewport_stream', args: { action: 'stop', sessionId: sceneSessionId, view: 'scene' } });
			send({ command: 'mcpToolCall', _requestId: 'stop_game', toolName: 'viewport_stream', args: { action: 'stop', sessionId: gameSessionId, view: 'game' } });
		} catch {
			// best effort
		}
		setTimeout(() => {
			try { socket.end(); } catch {}
			process.exit(code);
		}, 500);
		return;
	}
	process.exit(code);
}

function parsePorts(value) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		return [55500, 55501, 55502, 55503, 55504];
	}

	const parsed = value.split(',')
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
	return parsed.length === 0 ? [55500, 55501, 55502, 55503, 55504] : parsed;
}
