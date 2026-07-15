#!/usr/bin/env node
/**
 * Starts the bundled CursorUnityTool project in Unity batchmode and exposes a
 * local MJPEG viewport stream backed by Unity's viewport_stream test hook.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const projectRoot = path.join(repoRoot, 'CursorUnityTool');
const resultPath = '/tmp/uct-live-viewport-result.json';
const statusPath = '/tmp/uct-live-viewport-status.json';
const unityLogPath = '/tmp/uct-live-viewport.log';
const boundary = 'unity-cursor-toolkit-live-frame';

const options = {
	port: getIntArg('--port', 0),
	width: getIntArg('--width', 640),
	height: getIntArg('--height', 360),
	fps: getIntArg('--fps', 12),
	quality: getIntArg('--quality', 70),
	sessionId: getArg('--session-id', 'internal_live_view')
};

let unityProcess = null;
let shuttingDown = false;

async function main() {
	fs.rmSync(resultPath, { force: true });
	fs.rmSync(statusPath, { force: true });
	fs.rmSync(unityLogPath, { force: true });

	const server = http.createServer(handleRequest);
	await listen(server, options.port);
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	console.log('Unity Cursor Toolkit -- Live Internal Viewport\n');
	console.log(`Unity project: ${projectRoot}`);
	console.log(`Preview: ${baseUrl}/`);
	console.log(`MJPEG:   ${baseUrl}/viewport.mjpg`);
	console.log(`Latest:  ${baseUrl}/latest.jpg`);
	console.log(`Status:  ${baseUrl}/status.json`);
	console.log('\nPress Ctrl+C to stop Unity and the local stream server.\n');

	startUnity();

	process.on('SIGINT', () => stop(server, 0));
	process.on('SIGTERM', () => stop(server, 0));
}

function startUnity() {
	const unityPath = resolveUnityPath();
	const args = [
		'-batchmode',
		'-projectPath', projectRoot,
		'-executeMethod', 'UnityCursorToolkit.InternalSmoke.UnityCursorToolkitInternalSmoke.StartViewportStream',
		'-uctLiveViewportResultPath', resultPath,
		'-uctLiveViewportStatusPath', statusPath,
		'-uctLiveViewportSessionId', options.sessionId,
		'-uctLiveViewportWidth', String(options.width),
		'-uctLiveViewportHeight', String(options.height),
		'-uctLiveViewportFps', String(options.fps),
		'-uctLiveViewportQuality', String(options.quality),
		'-logFile', unityLogPath
	];

	console.log(`Unity: ${unityPath}`);
	unityProcess = spawn(unityPath, args, { stdio: 'inherit' });
	unityProcess.on('error', (error) => {
		console.error(error.stack || error.message || String(error));
		process.exitCode = 1;
	});
	unityProcess.on('exit', (code, signal) => {
		if (shuttingDown) {
			return;
		}

		console.error(`Unity exited unexpectedly with code=${code} signal=${signal}`);
		console.error(tail(unityLogPath, 80));
		process.exit(code === 0 ? 0 : 1);
	});
}

function handleRequest(req, res) {
	const url = new URL(req.url, 'http://127.0.0.1');
	if (url.pathname === '/') {
		sendHtml(res);
		return;
	}

	if (url.pathname === '/status.json') {
		sendJson(res);
		return;
	}

	if (url.pathname === '/latest.jpg') {
		sendLatestFrame(res);
		return;
	}

	if (url.pathname === '/viewport.mjpg') {
		sendMjpeg(req, res);
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end('Not found');
}

function sendHtml(res) {
	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store'
	});
	res.end(`<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Unity Cursor Toolkit Live Viewport</title>
	<style>
		body { margin: 0; background: #0c111a; color: #dbe7ff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		main { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
		header, footer { padding: 12px 16px; background: #111927; border-bottom: 1px solid #22304a; }
		footer { border-top: 1px solid #22304a; border-bottom: 0; font-size: 13px; color: #9fb0cc; }
		.viewport { display: grid; place-items: center; padding: 18px; }
		img { width: min(100%, 1280px); max-height: calc(100vh - 120px); object-fit: contain; image-rendering: auto; background: #06090f; border: 1px solid #2c3a56; }
		strong { color: #ffffff; }
		a { color: #8ab4ff; }
	</style>
</head>
<body>
	<main>
		<header><strong>Unity Cursor Toolkit Live Viewport</strong> <span id="status">waiting for frames...</span></header>
		<section class="viewport"><img src="/viewport.mjpg" alt="Unity live viewport stream"></section>
		<footer><a href="/latest.jpg">latest.jpg</a> · <a href="/status.json">status.json</a></footer>
	</main>
	<script>
		async function tick() {
			try {
				const res = await fetch('/status.json', { cache: 'no-store' });
				const json = await res.json();
				const status = json.unity && json.unity.sequence
					? 'sequence ' + json.unity.sequence + ' · ' + json.unity.width + 'x' + json.unity.height
					: 'waiting for frames...';
				document.getElementById('status').textContent = status;
			} catch {
				document.getElementById('status').textContent = 'status unavailable';
			}
		}
		setInterval(tick, 1000);
		tick();
	</script>
</body>
</html>`);
}

function sendJson(res) {
	const unity = readStatus();
	res.writeHead(200, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store'
	});
	res.end(JSON.stringify({
		success: true,
		unity,
		unityPid: unityProcess ? unityProcess.pid : null,
		resultPath,
		statusPath,
		unityLogPath
	}, null, 2));
}

function sendLatestFrame(res) {
	const frame = readLatestFrame();
	if (!frame) {
		res.writeHead(503, {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		res.end('No Unity viewport frame is available yet.');
		return;
	}

	res.writeHead(200, {
		'Content-Type': 'image/jpeg',
		'Content-Length': frame.buffer.length,
		'Cache-Control': 'no-store',
		'X-Unity-Sequence': String(frame.status.sequence || 0)
	});
	res.end(frame.buffer);
}

function sendMjpeg(req, res) {
	res.writeHead(200, {
		'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
		'Cache-Control': 'no-cache, no-store, must-revalidate',
		'Pragma': 'no-cache',
		'Connection': 'close'
	});

	let lastSequence = -1;
	const interval = setInterval(() => {
		const frame = readLatestFrame();
		if (!frame || frame.status.sequence === lastSequence) {
			return;
		}

		lastSequence = frame.status.sequence;
		res.write(`--${boundary}\r\n`);
		res.write('Content-Type: image/jpeg\r\n');
		res.write(`Content-Length: ${frame.buffer.length}\r\n`);
		res.write(`X-Unity-Sequence: ${lastSequence}\r\n\r\n`);
		res.write(frame.buffer);
		res.write('\r\n');
	}, Math.max(50, Math.floor(1000 / Math.max(1, options.fps))));

	req.on('close', () => {
		clearInterval(interval);
	});
}

function readLatestFrame() {
	const status = readStatus();
	if (!status || !status.lastFramePath || !fs.existsSync(status.lastFramePath)) {
		return null;
	}

	return {
		status,
		buffer: fs.readFileSync(status.lastFramePath)
	};
}

function readStatus() {
	try {
		return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
	} catch {
		return null;
	}
}

function resolveUnityPath() {
	if (process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH && fs.existsSync(process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH)) {
		return process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH;
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
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error('Unity executable not found. Set UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
}

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
}

function stop(server, code) {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	if (unityProcess && unityProcess.exitCode === null) {
		unityProcess.kill('SIGTERM');
	}

	server.close(() => {
		process.exit(code);
	});

	setTimeout(() => process.exit(code), 5000).unref();
}

function getArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index < process.argv.length - 1) {
		return process.argv[index + 1];
	}

	const prefix = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

function getIntArg(name, fallback) {
	const value = Number.parseInt(getArg(name, String(fallback)), 10);
	return Number.isFinite(value) ? value : fallback;
}

function tail(filePath, lines) {
	try {
		return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
	} catch {
		return '';
	}
}

main().catch((error) => {
	console.error(error.stack || error.message || String(error));
	process.exit(1);
});
