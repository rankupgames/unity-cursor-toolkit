// Real Node subprocess/TCP regressions for the existing player probe. No Unity launch.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const script = process.argv[2] || path.resolve(__dirname, '../scripts/probe-viewport-service.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-player-tcp-'));
const jpeg = Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(60), Buffer.from([255, 217])]).toString('base64');
let failures = 0;
async function run(name, check) {
	const sessions = new Map(), sockets = new Set(), calls = [];
	if (name === 'foreign-stream') sessions.set('foreign-game', 'game');
	const server = net.createServer(socket => {
		sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
		let buffer = '';
		socket.on('data', chunk => {
			buffer += chunk;
			let next;
			while ((next = buffer.indexOf('\n')) >= 0) {
				const value = JSON.parse(buffer.slice(0, next)); buffer = buffer.slice(next + 1);
				const reply = result => { if (!socket.writableEnded) socket.write(JSON.stringify({ command: 'mcpToolResult', _requestId: value._requestId, result }) + '\n'); };
				if (value.command === 'ping') socket.write((name === 'oversize-handshake' ? 'X'.repeat(9 * 1024 * 1024) + '\n' : '') + '{"command":"pong"}\n');
				else {
					const args = value.args; calls.push(args);
					if (args.action === 'status') reply(name === 'malformed-status' ? { success: true } : { success: true, host: 'player', sessions: sessions.size });
					else if (args.action === 'start') {
						sessions.set(args.sessionId, args.view);
						reply({ success: true, host: 'player', captureMode: 'camera', sessionId: args.sessionId });
						socket.write(JSON.stringify({ command: 'viewportFrame', sessionId: args.sessionId, host: 'player', captureMode: 'camera', width: 640, height: 360, data: name === 'invalid-jpeg' ? 'X'.repeat(100) : jpeg }) + '\n');
					} else if (args.action === 'input') reply({ success: true, layer: 'runtime' });
					else if (args.action === 'stop') {
						if (name === 'no-stop-ack') socket.end();
						else { sessions.delete(args.sessionId); reply({ success: true, host: 'player' }); }
					}
				}
			}
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const out = path.join(root, name + '.json');
	const child = spawn(process.execPath, [script, '--pid', String(name === 'wrong-pid' ? 2147483000 : process.pid), '--out', out],
		{ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(server.address().port) } });
	let stdout = '', stderr = '';
	child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
	try {
		const code = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { child.kill(); reject(new Error('Owned Node probe exceeded35seconds')); }, 35000);
			child.once('error', error => { clearTimeout(timer); reject(error); });
			child.once('exit', code => { clearTimeout(timer); resolve(code); });
		});
		const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
		check(code, { sessions, calls, result, stdout, stderr });
		console.log('PASS ' + name);
	} catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
	finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

async function measurementBoundary(withFrame) {
	const vm = require('vm'), { EventEmitter } = require('events');
	const scriptPath = process.argv[3] || path.resolve(__dirname, '../scripts/measure-viewport-service.js');
	const output = path.join(root, withFrame ? 'measurement-frame.json' : 'measurement-window.json');
	const framePath = path.join(root, 'first.jpg'), executable = path.join(root, 'owned-player.exe');
	fs.writeFileSync(executable, 'ownedVMspawnfixture');
	let live = false, child, frameTimer, fakeSession, emitted = 0, samplesRead = 0;
	const sockets = new Set();
	const server = net.createServer(socket => {
		sockets.add(socket); socket.on('close', () => sockets.delete(socket));
		let buffer = '';
		const frame = () => { emitted++; socket.write(JSON.stringify({ command: 'viewportFrame', sessionId: fakeSession, host: 'player', captureMode: 'camera', sequence: emitted, width: 1280, height: 720, data: jpeg }) + '\n'); };
		socket.on('data', chunk => {
			buffer += chunk;
			let next;
			while ((next = buffer.indexOf('\n')) >= 0) {
				const value = JSON.parse(buffer.slice(0, next)); buffer = buffer.slice(next + 1);
				const reply = result => socket.write(JSON.stringify({ command: 'mcpToolResult', _requestId: value._requestId, result }) + '\n');
				if (value.command === 'ping') socket.write('{"command":"pong"}\n');
				else if (value.args.action === 'status') reply({ success: true, host: 'player', sessions: fakeSession ? 1 : 0 });
				else if (value.args.action === 'start') {
					fakeSession = value.args.sessionId;
					reply({ success: true, host: 'player', sessionId: fakeSession, captureMode: 'camera' });
					frame(); frameTimer = setInterval(frame, 80);
				} else if (value.args.action === 'stop') setTimeout(() => { clearInterval(frameTimer); fakeSession = null; reply({ success: true, host: 'player' }); }, 400);
			}
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	let settleExit, boundaryError = null, firstSampleReport = null;
	const exited = new Promise(resolve => settleExit = resolve);
	const fakeProcess = {
		argv: [process.execPath, scriptPath, '--player', executable, '--port', String(server.address().port), '--idle-seconds', '0', '--duration', '1', '--sample-interval-ms', '5000', '--out', output, ...(withFrame ? ['--frame-out', framePath] : [])],
		platform: 'win32', arch: process.arch, version: process.version, env: process.env, exitCode: 0,
		once() {}, exit(code) { settleExit(code); },
		kill(pid, signal) { if (signal === 0) { if (!live) { const error = new Error('ownedfakegone'); error.code = 'ESRCH'; throw error; } return; } live = false; child.emit('exit', 0, null); }
	};
	const realOn = socket => {
		const on = socket.on;
		socket.on = function(event, callback) { return on.call(this, event, (...args) => { try { callback(...args); } catch (error) { boundaryError = error.message; settleExit(1); } }); };
		return socket;
	};
	const mockChildProcess = {
		spawn() { child = new EventEmitter(); child.pid = 123456; child.unref = () => {}; live = true; child.kill = () => fakeProcess.kill(child.pid, 'SIGTERM'); return child; },
		execFile(command, args, options, callback) {
			if (typeof options === 'function') callback = options;
			const text = args.join(' ');
			if (text.includes('Get-NetTCPConnection')) setTimeout(() => callback(null, JSON.stringify({ pids: live ? [123456] : [] })), 5);
			else { samplesRead++; setTimeout(() => callback(null, JSON.stringify({ rssMb: 12, cpuSeconds: samplesRead, sampleAt: Date.now() })), 1500); }
		}
	};
	const observedFs = { ...fs, writeFileSync(file, data, ...args) {
		if (file === output) {
			const report = JSON.parse(data);
			if (report.streamSamples.length > 0 && !firstSampleReport) firstSampleReport = report;
		}
		return fs.writeFileSync(file, data, ...args);
	} };
	try {
		const context = { require: name => name === 'fs' ? observedFs : name === 'child_process' ? mockChildProcess : name === 'net' ? { createConnection: (...args) => realOn(net.createConnection(...args)) } : require(name),
			__dirname: path.dirname(scriptPath), __filename: scriptPath, process: fakeProcess, console: { log() {}, error() {} }, Buffer, performance, setTimeout, clearTimeout, setInterval, clearInterval };
		vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });
		const guard = setTimeout(() => settleExit(1), 10000);
		const code = await exited; clearTimeout(guard);
		assert.strictEqual(boundaryError, null);
		assert.strictEqual(code, 0);
		const result = JSON.parse(fs.readFileSync(output, 'utf8'));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.streamSamples.length, 1, 'pending final sample must drain');
		assert(Number.isFinite(result.elapsedWindowSeconds) && result.elapsedWindowSeconds > 0, 'measured window duration');
		assert.strictEqual(firstSampleReport.elapsedWindowSeconds, result.elapsedWindowSeconds, 'window ends before sample drain');
		assert.strictEqual(firstSampleReport.streamFinishedAt, result.streamFinishedAt, 'window end excludes drain/stop');
		assert(Date.parse(result.lastFrameAt) <= Date.parse(result.streamFinishedAt), 'late drain/stop frames excluded');
		assert(result.frameCount < emitted, 'late frames actually emitted');
		assert.strictEqual(result.summary.streamWindowFps, Math.round(result.frameCount / result.elapsedWindowSeconds * 100) / 100);
		if (withFrame) assert(fs.readFileSync(framePath).equals(Buffer.from(jpeg, 'base64')), 'actual first JPEG written');
		console.log('PASS ' + (withFrame ? 'measurement-frame-write' : 'measurement-window-drain'));
	} catch (error) { failures++; console.error('FAIL measurement-boundary: ' + error.message); }
	finally { live = false; clearInterval(frameTimer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

(async () => {
	try {
		await measurementBoundary(true);
		await measurementBoundary(false);
		await run('normal', (code, state) => {
			assert.strictEqual(code, 0); assert.strictEqual(state.sessions.size, 0);
		});
		await run('wrong-pid', (code, state) => { assert.notStrictEqual(code, 0); assert.strictEqual(state.calls.length, 0); });
		await run('foreign-stream', (code, state) => {
			assert.notStrictEqual(code, 0); assert(state.sessions.has('foreign-game')); assert.strictEqual(state.sessions.size, 1);
			assert(!state.calls.some(item => item.action === 'start' || item.action === 'stop'));
		});
		await run('no-stop-ack', code => assert.notStrictEqual(code, 0));
		await run('invalid-jpeg', code => assert.notStrictEqual(code, 0));
		await run('malformed-status', code => assert.notStrictEqual(code, 0));
		await run('oversize-handshake', (code, state) => { assert.notStrictEqual(code, 0); assert.strictEqual(state.calls.length, 0); });
	} finally {
		const resolved = path.resolve(root);
		if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-player-tcp-')) throw new Error('invalid cleanup path');
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log('Player protocol regressions: ' + (9 - failures) + '/9 passed');
	process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
