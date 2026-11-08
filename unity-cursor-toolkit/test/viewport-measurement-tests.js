// Real child-process/TCP regression boundary for the existing measurement script.
// No Unity is launched. Windows metrics sample only the test's owned Node PID.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const script = process.argv[2] || path.resolve(__dirname, '../scripts/measure-editor-streaming.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-measure-test-'));
const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
let failures = 0;

async function run(name, behavior, extra, check) {
	let clients = new Set();
	const sessions = new Map();
	const calls = [];
	if (behavior === 'foreign-same-view') sessions.set('foreign-scene', { sessionId: 'foreign-scene', view: 'scene' });
	if (behavior === 'foreign-cleanup') sessions.set('foreign-game', { sessionId: 'foreign-game', view: 'game' });
	let started = false;
	const server = net.createServer(socket => {
		clients.add(socket); socket.on('close', () => clients.delete(socket));
		let buffer = '';
		socket.on('data', chunk => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const text = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				const message = JSON.parse(text);
				if (message.toolName === 'viewport_stream') calls.push(message.args);
				const reply = result => socket.write(JSON.stringify({ command: 'mcpToolResult', _requestId: message._requestId, result }) + '\n');
				if (message.command === 'ping') socket.write('{"command":"pong"}\n');
				else if (message.toolName === 'project_info' && behavior === 'missing-identity') reply({ success: false, error: 'Fixture refused project identity' });
				else if (message.toolName === 'project_info') reply({ projectPath: behavior === 'wrong-project' ? path.join(root, 'other') : root, unityVersion: '6000.3.9f1', runtime: { isCoreCLR: false } });
				else if (message.args?.action === 'start') {
					started = true;
					for (const [id, item] of sessions) if (id === message.args.sessionId || item.view === message.args.view) sessions.delete(id);
					sessions.set(message.args.sessionId, { sessionId: message.args.sessionId, view: message.args.view });
					if (behavior === 'foreign-cleanup') sessions.set('foreign-late-scene', { sessionId: 'foreign-late-scene', view: 'scene' });
					reply({ success: true, sessionId: message.args.sessionId });
					if (behavior !== 'no-frames') socket.write(JSON.stringify({ command: 'viewportFrame', sessionId: message.args.sessionId, width: 8, height: 8, data: jpeg }) + '\n');
				} else if (message.args?.action === 'stop') {
					if (behavior === 'no-stop-ack') socket.end();
					else {
						let stopped = 0;
						for (const [id, item] of sessions) if (id === message.args.sessionId || (message.args.view && item.view === message.args.view)) { sessions.delete(id); stopped++; }
						reply({ success: true, stopped, running: sessions.size > 0, runningSessions: sessions.size });
					}
				} else if (message.args?.action === 'status') {
					if (behavior === 'malformed-status' && started) reply({ success: true });
					else reply({ success: true, running: sessions.size > 0, sessions: [...sessions.values()], runningSessions: sessions.size });
				}
			}
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const out = path.join(root, name + '.json');
	const args = [script, ...extra, '--ports', String(server.address().port), '--project', root, '--pid', String(process.pid), '--idle-seconds', '0', '--duration', '1', '--out', out];
	const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, cwd: root });
	try {
		const code = await new Promise((resolve, reject) => {
			const guard = setTimeout(() => { child.kill(); reject(new Error('owned Node test exceeded40seconds')); }, 40000);
			child.once('error', error => { clearTimeout(guard); reject(error); });
			child.once('exit', code => { clearTimeout(guard); resolve(code); });
		});
		check(code, JSON.parse(fs.readFileSync(out, 'utf8')), { sessions, calls });
		console.log('PASS ' + name);
	} catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
	finally {
		for (const socket of clients) socket.destroy();
		await new Promise(resolve => server.close(resolve));
	}
}
(async () => {
	try {
		await run('wrong-project', 'wrong-project', [], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /target_mismatch/.test(item.message)));
		});
		await run('missing-identity', 'missing-identity', [], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /target_mismatch/.test(item.message)));
		});
		await run('foreign-same-view', 'foreign-same-view', [], (code, result, state) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /stream_view_occupied/.test(item.message)));
			assert.strictEqual(state.sessions.size, 1); assert(state.sessions.has('foreign-scene'));
			assert(!state.calls.some(item => item.action === 'start' || item.action === 'stop'));
		});
		await run('foreign-cleanup', 'foreign-cleanup', [], (code, result, state) => {
			assert.strictEqual(code, 0); assert.strictEqual(state.sessions.size, 2);
			assert(state.sessions.has('foreign-game')); assert(state.sessions.has('foreign-late-scene'));
			assert(state.calls.filter(item => item.action === 'stop').every(item => item.sessionId && !('view' in item)));
			assert(state.calls.filter(item => item.action === 'status' && item.sessionId).every(item => !('view' in item)));
		});
		await run('malformed-status', 'malformed-status', [], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /stream_status_invalid/.test(item.message)));
		});
		await run('no-frames', 'no-frames', [], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /frames_missing/.test(item.message)));
		});
		await run('no-stop-ack', 'no-stop-ack', [], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /bridge_timeout|stream_stop_unconfirmed/.test(item.message)));
		});
		await run('missing-metrics', 'normal', ['--sample-only', '--pid', '2147483000'], (code, result) => {
			assert.notStrictEqual(code, 0); assert(result.errors.some(item => /metrics_unavailable/.test(item.message)));
		});
		await run('drains-last-sample', 'normal', ['--sample-only', '--duration', '0'], (code, result) => {
			assert.strictEqual(code, 0); assert.strictEqual(result.streamSamples.length, 1); assert(Number.isFinite(result.streamSamples[0].rssMb));
		});
	} finally {
		const resolved = path.resolve(root);
		if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-measure-test-')) throw new Error('invalid test cleanup path');
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log('Measurement regressions: ' + (9 - failures) + '/9 passed');
	process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
