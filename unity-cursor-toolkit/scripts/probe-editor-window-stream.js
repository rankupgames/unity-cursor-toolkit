#!/usr/bin/env node
/**
 * Probes a running Unity Cursor Toolkit editor bridge for real EditorWindow
 * viewport streaming. This does not launch Unity; open the CursorUnityTool
 * project first, then run:
 *
 *   npm --prefix unity-cursor-toolkit run probe:editor-window-stream
 */

const net = require('net');

const ports = parsePorts(process.env.UNITY_CURSOR_TOOLKIT_MCP_PORTS);
const sceneSessionId = `probe_scene_${Date.now()}`;
const gameSessionId = `probe_game_${Date.now()}`;
const inspectorSessionId = `probe_inspector_${Date.now()}`;
const packageManagerSessionId = `probe_package_${Date.now()}`;
const customWindowSessionId = `probe_custom_window_${Date.now()}`;
const customWindowView = 'window:UnityCursorToolkit.InternalSmoke.UCTSpikeProbeWindow';

let socket;
let buffer = '';
let connectedPort = null;
let sceneStarted = false;
let sceneInput = false;
let sceneFrame = null;
let gameStarted = false;
let gameFrame = null;
let inspectorStarted = false;
let inspectorFrame = null;
let packageManagerStarted = false;
let packageManagerFrame = null;
let customWindowStarted = false;
let customWindowFrame = null;
let finished = false;

connectPort(0);

setTimeout(() => {
	fail('Timed out waiting for editor-window stream evidence.');
}, 40_000);

function connectPort(index) {
	if (index >= ports.length) {
		fail(`No Unity bridge accepted a TCP connection on ports: ${ports.join(', ')}`);
		return;
	}

	const port = ports[index];
	const candidate = net.createConnection({ host: '127.0.0.1', port });
	const timer = setTimeout(() => {
		candidate.destroy();
		connectPort(index + 1);
	}, 2_000);

	candidate.once('connect', () => {
		let handshakeBuffer = '';
		candidate.on('data', onHandshakeData);
		candidate.write('{"command":"ping"}\n');

		function onHandshakeData(chunk) {
			handshakeBuffer += chunk.toString();
			let newline;
			while ((newline = handshakeBuffer.indexOf('\n')) >= 0) {
				const line = handshakeBuffer.slice(0, newline).trim();
				handshakeBuffer = handshakeBuffer.slice(newline + 1);
				if (line.length === 0) {
					continue;
				}

				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}

				if (message.command === 'pong') {
					clearTimeout(timer);
					candidate.removeListener('data', onHandshakeData);
					socket = candidate;
					connectedPort = port;
					socket.on('data', onData);
					socket.on('error', (error) => fail(error.message || String(error)));
					console.log(`Connected to Unity toolkit bridge on ${port}.`);
					startProbe();
					return;
				}
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
			host: 'editor',
			view: 'scene',
			captureMode: 'editorWindow',
			fps: 1,
			quality: 55
		}
	});
	send({
		command: 'mcpToolCall',
		_requestId: 'start_game',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: gameSessionId,
			host: 'editor',
			view: 'game',
			captureMode: 'editorWindow',
			fps: 1,
			quality: 55
		}
	});
	send({
		command: 'mcpToolCall',
		_requestId: 'start_inspector',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: inspectorSessionId,
			host: 'editor',
			view: 'inspector',
			captureMode: 'editorWindow',
			fps: 1,
			quality: 55
		}
	});
	send({
		command: 'mcpToolCall',
		_requestId: 'start_package_manager',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: packageManagerSessionId,
			host: 'editor',
			view: 'packageManager',
			captureMode: 'editorWindow',
			fps: 1,
			quality: 55
		}
	});
	send({
		command: 'mcpToolCall',
		_requestId: 'start_custom_window',
		toolName: 'viewport_stream',
		args: {
			action: 'start',
			sessionId: customWindowSessionId,
			host: 'editor',
			view: customWindowView,
			captureMode: 'editorWindow',
			fps: 1,
			quality: 55
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

		handleMessage(message);
	}
}

function handleMessage(message) {
	if (message.command === 'mcpToolResult' && message._requestId === 'start_scene') {
		sceneStarted = isEditorWindowResult(message.result);
		if (sceneStarted) {
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
					x2: 220,
					y2: 160
				}
			});
		}
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'scene_input') {
		sceneInput = message.result?.success === true && message.result?.layer === 'editorWindow';
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'start_game') {
		gameStarted = isEditorWindowResult(message.result);
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'start_inspector') {
		inspectorStarted = isEditorWindowResult(message.result);
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'start_package_manager') {
		packageManagerStarted = isEditorWindowResult(message.result);
		maybeFinish();
		return;
	}

	if (message.command === 'mcpToolResult' && message._requestId === 'start_custom_window') {
		customWindowStarted = isEditorWindowResult(message.result);
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
		return;
	}

	if (message.command === 'viewportFrame' && message.sessionId === inspectorSessionId) {
		inspectorFrame = summarizeFrame(message);
		maybeFinish();
		return;
	}

	if (message.command === 'viewportFrame' && message.sessionId === packageManagerSessionId) {
		packageManagerFrame = summarizeFrame(message);
		maybeFinish();
	}

	if (message.command === 'viewportFrame' && message.sessionId === customWindowSessionId) {
		customWindowFrame = summarizeFrame(message);
		maybeFinish();
	}
}

function maybeFinish() {
	if (!sceneStarted || !sceneInput || !sceneFrame || !gameStarted || !gameFrame || !inspectorStarted || !inspectorFrame || !packageManagerStarted || !packageManagerFrame || !customWindowStarted || !customWindowFrame) {
		return;
	}

	const success = sceneFrame.captureMode === 'editorWindow'
		&& sceneFrame.hasData
		&& gameFrame.captureMode === 'editorWindow'
		&& gameFrame.hasData
		&& inspectorFrame.captureMode === 'editorWindow'
		&& inspectorFrame.hasData
		&& packageManagerFrame.captureMode === 'editorWindow'
		&& packageManagerFrame.hasData
		&& customWindowFrame.captureMode === 'editorWindow'
		&& customWindowFrame.hasData;

	if (!success) {
		fail('Probe completed but did not prove editor-window in-band frames.');
		return;
	}

	console.log('Scene frame:', JSON.stringify(sceneFrame));
	console.log('Game frame: ', JSON.stringify(gameFrame));
	console.log('Inspector frame:', JSON.stringify(inspectorFrame));
	console.log('Package Manager frame:', JSON.stringify(packageManagerFrame));
	console.log('Custom EditorWindow frame:', JSON.stringify(customWindowFrame));
	console.log('Scene input routed through editorWindow layer.');
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
		hasPath: typeof message.path === 'string' && message.path.length > 0,
		dataLength: typeof message.data === 'string' ? message.data.length : 0
	};
}

function isEditorWindowResult(result) {
	return result?.success === true
		&& result?.host === 'editor'
		&& result?.captureMode === 'editorWindow';
}

function send(payload) {
	socket.write(JSON.stringify(payload) + '\n');
}

function fail(message) {
	if (finished) {
		return;
	}
	console.error(`Probe failed: ${message}`);
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
			send({ command: 'mcpToolCall', _requestId: 'stop_inspector', toolName: 'viewport_stream', args: { action: 'stop', sessionId: inspectorSessionId, view: 'inspector' } });
			send({ command: 'mcpToolCall', _requestId: 'stop_package_manager', toolName: 'viewport_stream', args: { action: 'stop', sessionId: packageManagerSessionId, view: 'packageManager' } });
			send({ command: 'mcpToolCall', _requestId: 'stop_custom_window', toolName: 'viewport_stream', args: { action: 'stop', sessionId: customWindowSessionId, view: customWindowView } });
		} catch {
			// best effort cleanup
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
