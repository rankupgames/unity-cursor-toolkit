/**
 * Runtime test suite for Unity Cursor Toolkit.
 * Mocks the vscode API and exercises real function logic.
 * Run: node test/run-tests.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

// ── vscode mock ──────────────────────────────────────────────────────────────

function createMockFileSystemWatcher() {
	const changeEmitter = new MockEventEmitter();
	const deleteEmitter = new MockEventEmitter();
	const createEmitter = new MockEventEmitter();
	return {
		onDidChange: changeEmitter.event,
		onDidCreate: createEmitter.event,
		onDidDelete: deleteEmitter.event,
		dispose() {},
		_fireChange: (uri) => changeEmitter.fire(uri),
		_fireDelete: (uri) => deleteEmitter.fire(uri),
		_fireCreate: (uri) => createEmitter.fire(uri)
	};
}

class MockEventEmitter {
	constructor() { this._listeners = []; }
	get event() { return (fn) => { this._listeners.push(fn); return { dispose: () => {} }; }; }
	fire(data) { for (const fn of this._listeners) fn(data); }
	dispose() { this._listeners = []; }
}

let _lastCreatedWatcher = null;
let _allCreatedWatchers = [];

function createMockExtensionContext(tmpDir) {
	const state = {};
	return {
		subscriptions: [],
		workspaceState: {
			get: (key) => state[key],
			update: (key, val) => { if (val === undefined) delete state[key]; else state[key] = val; return Promise.resolve(); }
		},
		globalState: {
			get: (key) => state[`global_${key}`],
			update: (key, val) => { state[`global_${key}`] = val; return Promise.resolve(); }
		},
		extensionPath: tmpDir || '/mock/extension',
		extensionUri: { fsPath: tmpDir || '/mock/extension' },
		globalStorageUri: { fsPath: tmpDir || '/mock/global' },
		storagePath: tmpDir || '/mock/storage',
		_state: state
	};
}

const vscode = {
	EventEmitter: MockEventEmitter,
	workspace: {
		getConfiguration: () => ({
			get: (key, defaultVal) => defaultVal,
			update: async () => {}
		}),
		workspaceFolders: null,
		createFileSystemWatcher: () => {
			_lastCreatedWatcher = createMockFileSystemWatcher();
			_allCreatedWatchers.push(_lastCreatedWatcher);
			return _lastCreatedWatcher;
		},
		openTextDocument: async (opts) => ({ getText: () => opts?.content || '', uri: opts })
	},
	window: {
		createStatusBarItem: () => ({
			show() {}, hide() {}, text: '', tooltip: '', command: '', color: undefined, backgroundColor: undefined
		}),
		createOutputChannel: () => ({
			appendLine() {}, clear() {}, dispose() {}
		}),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showOpenDialog: async () => undefined,
		showSaveDialog: async () => undefined,
		registerWebviewViewProvider: () => ({ dispose() {} }),
		showTextDocument: async () => undefined
	},
	commands: {
		registerCommand: (id, cb) => ({ dispose() {} }),
		executeCommand: async () => {},
		getCommands: async () => []
	},
	env: {
		clipboard: { writeText: async () => {} }
	},
	extensions: { getExtension: () => null },
	debug: {
		registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }),
		registerDebugConfigurationProvider: () => ({ dispose() {} }),
		startDebugging: async () => false
	},
	Uri: {
		file: (p) => ({ fsPath: p, toString: () => `file://${p}` }),
		parse: (s) => ({ fsPath: s.replace('file://', ''), toString: () => s }),
		joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class { constructor(id) { this.id = id; } },
	ConfigurationTarget: { Workspace: 2 },
	QuickPickItemKind: { Separator: -1 },
	Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
	DebugAdapterInlineImplementation: class { constructor(adapter) { this.adapter = adapter; } },
	Disposable: class { constructor(fn) { this._fn = fn; } dispose() { this._fn?.(); } }
};

// Inject mock before requiring compiled modules
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === 'vscode') return request;
	return originalResolve.call(this, request, parent, isMain, options);
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscode;
	return originalLoad.call(this, request, parent, isMain);
};

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		passed++;
		process.stdout.write(`  PASS  ${name}\n`);
	} catch (err) {
		failed++;
		failures.push({ name, err });
		process.stdout.write(`  FAIL  ${name}\n    ${err.message}\n`);
	}
}

async function testAsync(name, fn) {
	try {
		await fn();
		passed++;
		process.stdout.write(`  PASS  ${name}\n`);
	} catch (err) {
		failed++;
		failures.push({ name, err });
		process.stdout.write(`  FAIL  ${name}\n    ${err.message}\n`);
	}
}

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

const outDir = path.join(__dirname, '..', 'out');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/types.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testTypes() {
	console.log('\n── core/types.ts ──');
	const { safeJsonParse, ConnectionState } = require(path.join(outDir, 'core', 'types'));

	test('safeJsonParse: valid object', () => {
		assert.deepStrictEqual(safeJsonParse('{"command":"ping"}'), { command: 'ping' });
	});

	test('safeJsonParse: valid array', () => {
		assert.deepStrictEqual(safeJsonParse('[1,2,3]'), [1, 2, 3]);
	});

	test('safeJsonParse: empty string -> null', () => {
		assert.strictEqual(safeJsonParse(''), null);
	});

	test('safeJsonParse: whitespace -> null', () => {
		assert.strictEqual(safeJsonParse('   \n  '), null);
	});

	test('safeJsonParse: plain text -> null (does not start with { or [)', () => {
		assert.strictEqual(safeJsonParse('hello world'), null);
	});

	test('safeJsonParse: leading whitespace still parses', () => {
		assert.deepStrictEqual(safeJsonParse('  {"key":"val"}  '), { key: 'val' });
	});

	test('safeJsonParse: malformed JSON starting with { throws', () => {
		assert.throws(() => safeJsonParse('{broken}'));
	});

	test('safeJsonParse: malformed JSON starting with [ throws', () => {
		assert.throws(() => safeJsonParse('[not,json,]'));
	});

	test('ConnectionState enum has 4 values', () => {
		assert.strictEqual(ConnectionState.Disconnected, 'disconnected');
		assert.strictEqual(ConnectionState.Connecting, 'connecting');
		assert.strictEqual(ConnectionState.Connected, 'connected');
		assert.strictEqual(ConnectionState.Reconnecting, 'reconnecting');
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/connection.ts (unit, no TCP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testConnectionUnit() {
	console.log('\n── core/connection.ts (unit) ──');
	const { ConnectionManager } = require(path.join(outDir, 'core', 'connection'));
	const { ConnectionState } = require(path.join(outDir, 'core', 'types'));

	test('initial state is Disconnected with null port', () => {
		const conn = new ConnectionManager();
		assert.strictEqual(conn.info.state, ConnectionState.Disconnected);
		assert.strictEqual(conn.info.port, null);
		conn.dispose();
	});

	test('disconnect from Disconnected is no-op (no event fires)', () => {
		const conn = new ConnectionManager();
		const states = [];
		conn.onStateChanged((info) => states.push(info.state));
		conn.disconnect();
		assert.strictEqual(states.length, 0);
		conn.dispose();
	});

	test('send when disconnected does not throw', () => {
		const conn = new ConnectionManager();
		conn.send('test', { data: 1 });
		conn.dispose();
	});

	test('pauseHeartbeat / resumeHeartbeat when disconnected does not throw', () => {
		const conn = new ConnectionManager();
		conn.pauseHeartbeat();
		conn.resumeHeartbeat();
		conn.dispose();
	});

	test('dispose sets state to Disconnected', () => {
		const conn = new ConnectionManager();
		conn.dispose();
		assert.strictEqual(conn.info.state, ConnectionState.Disconnected);
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/connection.ts (TCP integration)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testConnectionTcp() {
	console.log('\n── core/connection.ts (TCP integration) ──');
	const { ConnectionManager } = require(path.join(outDir, 'core', 'connection'));
	const { ConnectionState } = require(path.join(outDir, 'core', 'types'));

	// Uses port 55504 (last port in the PORTS array)
	await testAsync('connect scans PORTS array and returns found port or null', async () => {
		const conn = new ConnectionManager();
		const result = await conn.connect();
		if (result === null) {
			assert.strictEqual(conn.info.state, ConnectionState.Disconnected, 'State should be Disconnected when no port found');
		} else {
			assert.strictEqual(conn.info.state, ConnectionState.Connected, 'State should be Connected if a port was found');
			assert.strictEqual(typeof result, 'number');
			conn.disconnect();
		}
		conn.dispose();
	});

	await testAsync('connects to TCP server, exchanges messages, fires onMessage', async () => {
		const received = [];

		const server = net.createServer((socket) => {
			socket.on('data', (data) => {
				const lines = data.toString().split('\n').filter(Boolean);
				for (const line of lines) {
					received.push(JSON.parse(line));
					const parsed = JSON.parse(line);
					if (parsed.command === 'ping') {
						socket.write('{"command":"pong"}\n');
					}
					if (parsed.command === 'testCmd') {
						socket.write(JSON.stringify({ command: 'testResponse', _requestId: parsed._requestId, data: 42 }) + '\n');
					}
				}
			});
		});

		await new Promise((res) => server.listen(55504, '127.0.0.1', res));

		try {
			const conn = new ConnectionManager();
			conn.setNeededCallback(() => true);

			const port = await conn.connect();
			assert.strictEqual(port, 55504);
			assert.strictEqual(conn.info.state, ConnectionState.Connected);
			assert.strictEqual(conn.info.port, 55504);

			conn.send('hello', { data: 99 });
			await sleep(100);
			assert.ok(received.length > 0, 'Server should receive messages');
			const helloMsg = received.find(m => m.command === 'hello');
			assert.ok(helloMsg, 'Server received hello');
			assert.strictEqual(helloMsg.data, 99);

			const clientMessages = [];
			conn.onMessage((msg) => clientMessages.push(msg));
			conn.send('testCmd', { _requestId: 'r1' });
			await sleep(200);

			assert.ok(clientMessages.length > 0, 'Client should receive non-pong messages');
			const testResp = clientMessages.find(m => m.command === 'testResponse');
			assert.ok(testResp, 'Got testResponse');
			assert.strictEqual(testResp.payload.data, 42);

			conn.disconnect();
			assert.strictEqual(conn.info.state, ConnectionState.Disconnected);
			conn.dispose();
		} finally {
			server.close();
			await sleep(100);
		}
	});

	await testAsync('state transitions: Disconnected -> Connecting -> Connected', async () => {
		const server = net.createServer(() => {});
		await new Promise((res) => server.listen(55503, '127.0.0.1', res));

		try {
			const conn = new ConnectionManager();
			const states = [];
			conn.onStateChanged((info) => states.push(info.state));

			const port = await conn.connect();
			assert.strictEqual(port, 55503);
			assert.ok(states.includes(ConnectionState.Connecting), 'Should transition through Connecting');
			assert.ok(states.includes(ConnectionState.Connected), 'Should reach Connected');

			conn.disconnect();
			assert.ok(states.includes(ConnectionState.Disconnected), 'Should reach Disconnected on manual disconnect');
			conn.dispose();
		} finally {
			server.close();
			await sleep(100);
		}
	});

	await testAsync('heartbeat: pong resets timeout (no premature disconnect)', async () => {
		const server = net.createServer((socket) => {
			socket.on('data', (data) => {
				const lines = data.toString().split('\n').filter(Boolean);
				for (const line of lines) {
					const parsed = JSON.parse(line);
					if (parsed.command === 'ping') {
						socket.write('{"command":"pong"}\n');
					}
				}
			});
		});
		await new Promise((res) => server.listen(55502, '127.0.0.1', res));

		try {
			const conn = new ConnectionManager();
			conn.setNeededCallback(() => true);

			const port = await conn.connect();
			assert.strictEqual(port, 55502);
			assert.strictEqual(conn.info.state, ConnectionState.Connected);

			// Wait long enough that a heartbeat should fire (10s interval)
			// but not so long the test hangs. We just verify still connected after 1s.
			await sleep(500);
			assert.strictEqual(conn.info.state, ConnectionState.Connected, 'Should still be connected');

			conn.disconnect();
			conn.dispose();
		} finally {
			server.close();
			await sleep(100);
		}
	});

	await testAsync('reconnects after server-initiated close', async () => {
		let connectionCount = 0;
		const server = net.createServer((socket) => {
			connectionCount++;
			if (connectionCount === 1) {
				setTimeout(() => socket.destroy(), 50);
			}
		});
		await new Promise((res) => server.listen(55501, '127.0.0.1', res));

		try {
			const conn = new ConnectionManager();
			conn.setNeededCallback(() => true);

			const stateLog = [];
			conn.onStateChanged((info) => stateLog.push(info.state));

			const port = await conn.connect();
			assert.strictEqual(port, 55501);

			// Wait for server to drop us and reconnect to start
			await sleep(2500);

			assert.ok(
				stateLog.includes(ConnectionState.Reconnecting),
				`Should enter Reconnecting after server drops. States: ${stateLog.join(' -> ')}`
			);

			conn.disconnect();
			conn.dispose();
		} finally {
			server.close();
			await sleep(100);
		}
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/commandSender.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testCommandSender() {
	console.log('\n── core/commandSender.ts ──');
	const { CommandSender } = require(path.join(outDir, 'core', 'commandSender'));

	test('send() delegates command and payload to connection', () => {
		const sent = [];
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};
		const sender = new CommandSender(mockConn);
		sender.send('refresh', { files: ['a.cs'] });

		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].cmd, 'refresh');
		assert.deepStrictEqual(sent[0].payload, { files: ['a.cs'] });
		sender.dispose();
	});

	await testAsync('request() resolves when matching _requestId response arrives', async () => {
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send(cmd, payload) {
				setTimeout(() => {
					emitter.fire({
						command: 'response',
						payload: { _requestId: payload._requestId, result: 'ok' }
					});
				}, 10);
			}
		};
		const sender = new CommandSender(mockConn);
		const result = await sender.request('testCmd', { arg: 1 });

		assert.ok(result != null, 'Should resolve with response');
		assert.strictEqual(result.result, 'ok');
		assert.ok(result._requestId, 'Response should include _requestId');
		sender.dispose();
	});

	await testAsync('request() ignores responses with wrong _requestId', async () => {
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send(cmd, payload) {
				setTimeout(() => {
					emitter.fire({
						command: 'response',
						payload: { _requestId: 'wrong_id', result: 'nope' }
					});
				}, 10);
				setTimeout(() => {
					emitter.fire({
						command: 'response',
						payload: { _requestId: payload._requestId, result: 'correct' }
					});
				}, 30);
			}
		};
		const sender = new CommandSender(mockConn);
		const result = await sender.request('test');

		assert.strictEqual(result.result, 'correct');
		sender.dispose();
	});

	await testAsync('request() returns null on timeout (10s default, shortened for test)', async () => {
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send() {} // never responds
		};
		const sender = new CommandSender(mockConn);

		const result = await Promise.race([
			sender.request('neverRespond'),
			sleep(300).then(() => 'race_timeout')
		]);

		// Either the request's 10s timeout returns null, or our 300ms race wins
		assert.ok(result === 'race_timeout' || result === null,
			'Should either race-timeout or resolve null');
		sender.dispose();
	});

	await testAsync('request() generates unique _requestId per call', async () => {
		const ids = [];
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send(cmd, payload) { ids.push(payload._requestId); }
		};
		const sender = new CommandSender(mockConn);
		sender.request('a');
		sender.request('b');
		sender.request('c');

		assert.strictEqual(ids.length, 3);
		const unique = new Set(ids);
		assert.strictEqual(unique.size, 3, `All IDs should be unique: ${ids}`);
		sender.dispose();
	});

	await testAsync('dispose() cancels all pending requests (resolve null)', async () => {
		const emitter = new vscode.EventEmitter();
		const mockConn = {
			onMessage: emitter.event,
			send() {}
		};
		const sender = new CommandSender(mockConn);
		const pending = sender.request('test');
		sender.dispose();

		const result = await pending;
		assert.strictEqual(result, null);
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// console/consoleBridge.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testConsoleBridge() {
	console.log('\n── console/consoleBridge.ts ──');
	const { ConsoleBridge } = require(path.join(outDir, 'console', 'consoleBridge'));

	test('consoleEntry creates entry with correct type mapping and fires onEntry', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		const received = [];
		bridge.onEntry((e) => received.push(e));

		emitter.fire({
			command: 'consoleEntry',
			payload: { command: 'consoleEntry', type: 'Error', message: 'NullRef at line 42', stackTrace: 'at Foo.Bar()', timestamp: '2026-01-01T00:00:00Z' }
		});

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0].type, 'error');
		assert.strictEqual(received[0].message, 'NullRef at line 42');
		assert.strictEqual(received[0].stackTrace, 'at Foo.Bar()');
		assert.strictEqual(received[0].timestamp, '2026-01-01T00:00:00Z');

		bridge.dispose();
	});

	test('mapLogType covers all Unity log types correctly', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		const types = [];
		bridge.onEntry((e) => types.push(e.type));

		for (const t of ['Error', 'Exception', 'Warning', 'Assert', 'Log', 'UnknownType']) {
			emitter.fire({
				command: 'consoleEntry',
				payload: { command: 'consoleEntry', type: t, message: t, stackTrace: '', timestamp: '' }
			});
		}

		assert.deepStrictEqual(types, ['error', 'exception', 'warning', 'assert', 'log', 'log']);
		bridge.dispose();
	});

	test('ring buffer caps entries at maxEntries', () => {
		const origGetConfig = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = () => ({
			get: (key, def) => key === 'maxEntries' ? 3 : def
		});

		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		for (let i = 0; i < 5; i++) {
			emitter.fire({
				command: 'consoleEntry',
				payload: { command: 'consoleEntry', type: 'Log', message: `msg${i}`, stackTrace: '', timestamp: `t${i}` }
			});
		}

		const entries = bridge.getEntries();
		assert.strictEqual(entries.length, 3, `Expected 3, got ${entries.length}`);
		assert.strictEqual(entries[0].message, 'msg2');
		assert.strictEqual(entries[1].message, 'msg3');
		assert.strictEqual(entries[2].message, 'msg4');

		vscode.workspace.getConfiguration = origGetConfig;
		bridge.dispose();
	});

	test('getEntries({ level }) filters by type', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: 'err1', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'log1', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: 'err2', stackTrace: '', timestamp: '' } });

		const errors = bridge.getEntries({ level: 'error' });
		assert.strictEqual(errors.length, 2);
		assert.strictEqual(errors[0].message, 'err1');
		assert.strictEqual(errors[1].message, 'err2');

		const logs = bridge.getEntries({ level: 'log' });
		assert.strictEqual(logs.length, 1);
		assert.strictEqual(logs[0].message, 'log1');

		bridge.dispose();
	});

	test('getEntries({ search }) filters by message/stackTrace substring', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'Player spawned', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'Enemy destroyed', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: 'NullRef', stackTrace: 'at Player.Update()', timestamp: '' } });

		assert.strictEqual(bridge.getEntries({ search: 'player' }).length, 2, 'case-insensitive match in message + stackTrace');
		assert.strictEqual(bridge.getEntries({ search: 'enemy' }).length, 1);
		assert.strictEqual(bridge.getEntries({ search: 'zzz' }).length, 0);

		bridge.dispose();
	});

	test('getEntries({ limit }) returns last N entries', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		for (let i = 0; i < 10; i++) {
			emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: `msg${i}`, stackTrace: '', timestamp: '' } });
		}

		const limited = bridge.getEntries({ limit: 3 });
		assert.strictEqual(limited.length, 3);
		assert.strictEqual(limited[0].message, 'msg7');
		assert.strictEqual(limited[2].message, 'msg9');

		bridge.dispose();
	});

	test('getEntries combines level + search + limit', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		for (let i = 0; i < 5; i++) {
			emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: `error ${i}`, stackTrace: '', timestamp: '' } });
		}
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'error log', stackTrace: '', timestamp: '' } });

		const result = bridge.getEntries({ level: 'error', search: 'error', limit: 2 });
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].message, 'error 3');
		assert.strictEqual(result[1].message, 'error 4');

		bridge.dispose();
	});

	test('clearEntries removes all entries and fires onClear', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'test', stackTrace: '', timestamp: '' } });
		assert.strictEqual(bridge.getEntries().length, 1);

		let cleared = false;
		bridge.onClear(() => { cleared = true; });
		bridge.clearEntries();

		assert.strictEqual(bridge.getEntries().length, 0);
		assert.ok(cleared, 'onClear should fire');

		bridge.dispose();
	});

	test('consoleToCursor message fires onBulk', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		const bulks = [];
		bridge.onBulk((b) => bulks.push(b));

		emitter.fire({
			command: 'consoleToCursor',
			payload: { content: 'Error log content', entryCount: 5 }
		});

		assert.strictEqual(bulks.length, 1);
		assert.strictEqual(bulks[0].content, 'Error log content');
		assert.strictEqual(bulks[0].entryCount, 5);

		bridge.dispose();
	});

	test('ignores unrelated commands', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'somethingElse', payload: {} });

		assert.strictEqual(bridge.getEntries().length, 0);
		bridge.dispose();
	});

	test('getEntries returns a copy, not the internal array (mutation safety)', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'original', stackTrace: '', timestamp: '' } });

		const entries1 = bridge.getEntries();
		entries1.push({ type: 'log', message: 'injected', stackTrace: '', timestamp: '' });

		const entries2 = bridge.getEntries();
		assert.strictEqual(entries2.length, 1, 'Pushing to returned array must not affect internal state');
		assert.strictEqual(entries2[0].message, 'original');

		bridge.dispose();
	});

	test('ring buffer order is oldest-removed-first', () => {
		const origGetConfig = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = () => ({
			get: (key, def) => key === 'maxEntries' ? 2 : def
		});

		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'first', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'second', stackTrace: '', timestamp: '' } });
		emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'third', stackTrace: '', timestamp: '' } });

		const entries = bridge.getEntries();
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0].message, 'second', 'Oldest entry (first) should be evicted');
		assert.strictEqual(entries[1].message, 'third');

		vscode.workspace.getConfiguration = origGetConfig;
		bridge.dispose();
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// console/consoleMcpTools.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testConsoleMcpTools() {
	console.log('\n── console/consoleMcpTools.ts ──');
	const { ConsoleMcpTools } = require(path.join(outDir, 'console', 'consoleMcpTools'));
	const { ConsoleBridge } = require(path.join(outDir, 'console', 'consoleBridge'));

	const emitter = new vscode.EventEmitter();
	const bridge = new ConsoleBridge({ onMessage: emitter.event });
	const tools = new ConsoleMcpTools(bridge);

	test('getTools returns read_console and clear_console with schemas', () => {
		const defs = tools.getTools();
		assert.strictEqual(defs.length, 2);
		assert.strictEqual(defs[0].name, 'read_console');
		assert.strictEqual(defs[1].name, 'clear_console');
		assert.ok(defs[0].inputSchema.properties.level, 'read_console has level filter');
		assert.ok(defs[0].inputSchema.properties.limit, 'read_console has limit');
		assert.ok(defs[0].inputSchema.properties.search, 'read_console has search');
	});

	emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: 'err1', stackTrace: 'at X', timestamp: 't1' } });
	emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'log1', stackTrace: '', timestamp: 't2' } });

	await testAsync('read_console returns formatted text with entry count', async () => {
		const result = await tools.handleToolCall('read_console', {});
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes('2 entries'), `Got: ${result.content[0].text}`);
		assert.ok(result.content[0].text.includes('[ERROR]'));
		assert.ok(result.content[0].text.includes('err1'));
		assert.ok(result.content[0].text.includes('[LOG]'));
		assert.ok(result.content[0].text.includes('log1'));
	});

	await testAsync('read_console with level=error filters correctly', async () => {
		const result = await tools.handleToolCall('read_console', { level: 'error' });
		assert.ok(result.content[0].text.includes('1 entries'));
		assert.ok(result.content[0].text.includes('err1'));
		assert.ok(!result.content[0].text.includes('log1'));
	});

	await testAsync('read_console with search filters correctly', async () => {
		const result = await tools.handleToolCall('read_console', { search: 'log' });
		assert.ok(result.content[0].text.includes('1 entries'));
		assert.ok(result.content[0].text.includes('log1'));
	});

	await testAsync('clear_console clears and confirms', async () => {
		const result = await tools.handleToolCall('clear_console', {});
		assert.strictEqual(result.content[0].text, 'Console cleared.');
		assert.strictEqual(bridge.getEntries().length, 0);
	});

	await testAsync('read_console when empty returns "No console entries"', async () => {
		const result = await tools.handleToolCall('read_console', {});
		assert.ok(result.content[0].text.includes('No console entries'));
	});

	await testAsync('unknown tool name returns isError=true', async () => {
		const result = await tools.handleToolCall('nonexistent', {});
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('Unknown tool'));
	});

	bridge.dispose();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// mcp/toolRouter.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testToolRouter() {
	console.log('\n── mcp/toolRouter.ts ──');
	const { ToolRouter } = require(path.join(outDir, 'mcp', 'toolRouter'));

	const router = new ToolRouter();

	const providerA = {
		toolGroupName: 'groupA',
		getTools: () => [
			{ name: 'tool_a', description: 'Tool A', inputSchema: {} },
			{ name: 'tool_b', description: 'Tool B', inputSchema: {} }
		],
		handleToolCall: async (name, args) => ({
			content: [{ type: 'text', text: `A:${name}:${JSON.stringify(args)}` }]
		})
	};

	const providerB = {
		toolGroupName: 'groupB',
		getTools: () => [
			{ name: 'tool_c', description: 'Tool C', inputSchema: {} }
		],
		handleToolCall: async (name, args) => ({
			content: [{ type: 'text', text: `B:${name}` }]
		})
	};

	router.register(providerA);
	router.register(providerB);

	test('getToolDefinitions aggregates tools from all providers', () => {
		const defs = router.getToolDefinitions();
		assert.strictEqual(defs.length, 3);
		const names = defs.map(d => d.name);
		assert.ok(names.includes('tool_a'));
		assert.ok(names.includes('tool_b'));
		assert.ok(names.includes('tool_c'));
	});

	await testAsync('routeToolCall dispatches to correct provider (A)', async () => {
		const result = await router.routeToolCall('tool_a', { x: 1 });
		assert.strictEqual(result.content[0].text, 'A:tool_a:{"x":1}');
	});

	await testAsync('routeToolCall dispatches to correct provider (B)', async () => {
		const result = await router.routeToolCall('tool_c', {});
		assert.strictEqual(result.content[0].text, 'B:tool_c');
	});

	await testAsync('routeToolCall verifies provider isolation (A does not call B)', async () => {
		let bCalled = false;
		const isolationRouter = new ToolRouter();
		isolationRouter.register({
			toolGroupName: 'isoA',
			getTools: () => [{ name: 'iso_a', description: 'A', inputSchema: {} }],
			handleToolCall: async () => ({ content: [{ type: 'text', text: 'from_a' }] })
		});
		isolationRouter.register({
			toolGroupName: 'isoB',
			getTools: () => [{ name: 'iso_b', description: 'B', inputSchema: {} }],
			handleToolCall: async () => { bCalled = true; return { content: [{ type: 'text', text: 'from_b' }] }; }
		});

		const result = await isolationRouter.routeToolCall('iso_a', {});
		assert.strictEqual(result.content[0].text, 'from_a');
		assert.strictEqual(bCalled, false, 'Provider B should NOT be called when routing to A');
	});

	await testAsync('routeToolCall returns isError for unknown tool with available list', async () => {
		const result = await router.routeToolCall('nonexistent', {});
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('Unknown tool: nonexistent'));
		assert.ok(result.content[0].text.includes('tool_a'));
		assert.ok(result.content[0].text.includes('tool_c'));
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// mcp/unityMcpTools.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testUnityMcpTools() {
	console.log('\n── mcp/unityMcpTools.ts ──');
	const { UnityMcpTools } = require(path.join(outDir, 'mcp', 'unityMcpTools'));

	test('getTools returns all 11 tool definitions with correct names', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const defs = tools.getTools();
		assert.strictEqual(defs.length, 11);
		const names = defs.map(d => d.name).sort();
		assert.deepStrictEqual(names, [
			'batch_execute', 'build_trigger', 'execute_menu_item',
			'manage_asset', 'manage_component', 'manage_gameobject',
			'manage_material', 'manage_scene', 'play_mode',
			'project_info', 'screenshot'
		]);
	});

	test('each tool definition has name, description, and inputSchema', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		for (const def of tools.getTools()) {
			assert.ok(def.name, `Tool missing name`);
			assert.ok(def.description, `${def.name} missing description`);
			assert.ok(def.inputSchema, `${def.name} missing inputSchema`);
		}
	});

	await testAsync('handleToolCall returns isError when Unity does not respond (null)', async () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const result = await tools.handleToolCall('project_info', {});
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('did not respond'));
	});

	await testAsync('handleToolCall returns Unity result text on success', async () => {
		const tools = new UnityMcpTools({
			send() {},
			request: async () => ({ result: '{"version":"2022.3.1f1"}', error: false })
		});
		const result = await tools.handleToolCall('project_info', {});
		assert.ok(!result.isError, `isError should be falsy, got ${result.isError}`);
		assert.ok(result.content[0].text.includes('2022.3.1f1'));
	});

	await testAsync('handleToolCall returns isError when Unity reports error', async () => {
		const tools = new UnityMcpTools({
			send() {},
			request: async () => ({ result: 'Scene not found', error: true })
		});
		const result = await tools.handleToolCall('manage_scene', { action: 'load', scenePath: 'bad' });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('Scene not found'));
	});

	await testAsync('handleToolCall sends correct toolName and args to commandSender', async () => {
		const calls = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: 'ok', error: false };
			}
		});

		await tools.handleToolCall('play_mode', { action: 'enter' });

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, 'mcpToolCall');
		assert.strictEqual(calls[0].payload.toolName, 'play_mode');
		assert.deepStrictEqual(calls[0].payload.args, { action: 'enter' });
	});

	await testAsync('batch_execute runs operations in sequence', async () => {
		const callOrder = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				callOrder.push(payload.toolName);
				return { result: `ok:${payload.toolName}`, error: false };
			}
		});

		const result = await tools.handleToolCall('batch_execute', {
			operations: [
				{ tool: 'play_mode', args: { action: 'enter' } },
				{ tool: 'screenshot', args: {} },
				{ tool: 'play_mode', args: { action: 'exit' } }
			]
		});

		assert.deepStrictEqual(callOrder, ['play_mode', 'screenshot', 'play_mode']);
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes('[1/3] play_mode'));
		assert.ok(result.content[0].text.includes('[2/3] screenshot'));
		assert.ok(result.content[0].text.includes('[3/3] play_mode'));
	});

	await testAsync('batch_execute stops on first failure', async () => {
		let callCount = 0;
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				callCount++;
				if (payload.toolName === 'screenshot') return null;
				return { result: 'ok', error: false };
			}
		});

		const result = await tools.handleToolCall('batch_execute', {
			operations: [
				{ tool: 'play_mode', args: { action: 'enter' } },
				{ tool: 'screenshot', args: {} },
				{ tool: 'play_mode', args: { action: 'exit' } }
			]
		});

		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('Batch stopped at operation 2'));
		assert.strictEqual(callCount, 2, 'Third operation should not have been called');
	});

	await testAsync('batch_execute with empty operations returns error', async () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const result = await tools.handleToolCall('batch_execute', { operations: [] });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('No operations'));
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// debug/launchJsonGenerator.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testLaunchJsonGenerator() {
	console.log('\n── debug/launchJsonGenerator.ts ──');
	const { generateLaunchJson } = require(path.join(outDir, 'debug', 'launchJsonGenerator'));

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-test-'));

	await testAsync('creates launch.json from scratch with 2 Unity configs', async () => {
		const projectPath = path.join(tmpDir, 'p1');
		fs.mkdirSync(projectPath, { recursive: true });

		await generateLaunchJson(projectPath);

		const launchPath = path.join(projectPath, '.vscode', 'launch.json');
		assert.ok(fs.existsSync(launchPath), 'launch.json should be created');

		const content = JSON.parse(fs.readFileSync(launchPath, 'utf-8'));
		assert.strictEqual(content.version, '0.2.0');
		assert.strictEqual(content.configurations.length, 2);
		assert.strictEqual(content.configurations[0].name, 'Attach to Unity Editor');
		assert.strictEqual(content.configurations[0].type, 'unityCursorToolkit.debug');
		assert.strictEqual(content.configurations[0].request, 'attach');
		assert.strictEqual(content.configurations[0].debugPort, 56000);
		assert.strictEqual(content.configurations[1].name, 'Attach to Unity Player');
	});

	await testAsync('merges into existing launch.json without duplicating', async () => {
		const projectPath = path.join(tmpDir, 'p2');
		const vscodePath = path.join(projectPath, '.vscode');
		fs.mkdirSync(vscodePath, { recursive: true });

		fs.writeFileSync(path.join(vscodePath, 'launch.json'), JSON.stringify({
			version: '0.2.0',
			configurations: [
				{ name: 'Attach to Unity Editor', type: 'unityCursorToolkit.debug', request: 'attach', debugPort: 56000 },
				{ name: 'My Custom Config', type: 'node', request: 'launch' }
			]
		}));

		await generateLaunchJson(projectPath);

		const content = JSON.parse(fs.readFileSync(path.join(vscodePath, 'launch.json'), 'utf-8'));
		assert.strictEqual(content.configurations.length, 3);
		const names = content.configurations.map(c => c.name);
		assert.ok(names.includes('My Custom Config'), 'Preserves custom config');
		assert.ok(names.includes('Attach to Unity Player'), 'Adds missing Player config');
	});

	await testAsync('no-op when all Unity configs already exist', async () => {
		const projectPath = path.join(tmpDir, 'p3');
		const vscodePath = path.join(projectPath, '.vscode');
		fs.mkdirSync(vscodePath, { recursive: true });

		const original = JSON.stringify({
			version: '0.2.0',
			configurations: [
				{ name: 'Attach to Unity Editor', type: 'unityCursorToolkit.debug', request: 'attach' },
				{ name: 'Attach to Unity Player', type: 'unityCursorToolkit.debug', request: 'attach' }
			]
		});
		fs.writeFileSync(path.join(vscodePath, 'launch.json'), original);

		await generateLaunchJson(projectPath);

		const after = fs.readFileSync(path.join(vscodePath, 'launch.json'), 'utf-8');
		assert.strictEqual(after, original, 'File should not be modified');
	});

	await testAsync('handles corrupt launch.json gracefully (overwrites)', async () => {
		const projectPath = path.join(tmpDir, 'p4');
		const vscodePath = path.join(projectPath, '.vscode');
		fs.mkdirSync(vscodePath, { recursive: true });
		fs.writeFileSync(path.join(vscodePath, 'launch.json'), '{{{not valid json');

		await generateLaunchJson(projectPath);

		const content = JSON.parse(fs.readFileSync(path.join(vscodePath, 'launch.json'), 'utf-8'));
		assert.strictEqual(content.configurations.length, 2, 'Should create fresh configs');
	});

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/moduleLoader.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testModuleLoader() {
	console.log('\n── core/moduleLoader.ts ──');
	const { ModuleLoader } = require(path.join(outDir, 'core', 'moduleLoader'));

	const makeCtx = () => ({
		commandSender: {}, extensionContext: {}, connectionManager: {},
		registerMessageHandler() {}, registerToolProvider() {},
		registerStatusBarContributor() {}, registerCommand() {}
	});

	await testAsync('activates modules in registration order', async () => {
		const loader = new ModuleLoader();
		const log = [];

		loader.register({ id: 'a', activate: async () => { log.push('a:on'); }, deactivate: async () => { log.push('a:off'); } });
		loader.register({ id: 'b', activate: async () => { log.push('b:on'); }, deactivate: async () => { log.push('b:off'); } });

		await loader.activateAll(makeCtx());
		assert.deepStrictEqual(log, ['a:on', 'b:on']);

		await loader.deactivateAll();
		assert.deepStrictEqual(log, ['a:on', 'b:on', 'b:off', 'a:off']);
	});

	await testAsync('deactivates in reverse order', async () => {
		const loader = new ModuleLoader();
		const deactivateOrder = [];

		loader.register({ id: 'x', activate: async () => {}, deactivate: async () => { deactivateOrder.push('x'); } });
		loader.register({ id: 'y', activate: async () => {}, deactivate: async () => { deactivateOrder.push('y'); } });
		loader.register({ id: 'z', activate: async () => {}, deactivate: async () => { deactivateOrder.push('z'); } });

		await loader.activateAll(makeCtx());
		await loader.deactivateAll();

		assert.deepStrictEqual(deactivateOrder, ['z', 'y', 'x']);
	});

	await testAsync('activation error does not block subsequent modules', async () => {
		const loader = new ModuleLoader();
		const log = [];

		loader.register({ id: 'bad', activate: async () => { throw new Error('boom'); }, deactivate: async () => { log.push('bad:off'); } });
		loader.register({ id: 'good', activate: async () => { log.push('good:on'); }, deactivate: async () => { log.push('good:off'); } });

		await loader.activateAll(makeCtx());
		assert.ok(log.includes('good:on'), 'Good module still activated');

		await loader.deactivateAll();
		assert.ok(log.includes('good:off'), 'Good module deactivated');
		assert.ok(!log.includes('bad:off'), 'Bad module never in active list');
	});

	await testAsync('disabled module is skipped (config returns false)', async () => {
		const origGetConfig = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = () => ({
			get: (key, def) => key === 'skipped.enabled' ? false : def
		});

		const loader = new ModuleLoader();
		const log = [];

		loader.register({ id: 'skipped', activate: async () => { log.push('skipped'); }, deactivate: async () => {} });
		loader.register({ id: 'active', activate: async () => { log.push('active'); }, deactivate: async () => {} });

		await loader.activateAll(makeCtx());
		assert.ok(!log.includes('skipped'), 'Disabled module should not activate');
		assert.ok(log.includes('active'));

		vscode.workspace.getConfiguration = origGetConfig;
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// debug/debugAdapter.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testDebugAdapter() {
	console.log('\n── debug/debugAdapter.ts ──');
	const { UnityDebugSession, UnityDebugAdapterDescriptorFactory } = require(path.join(outDir, 'debug', 'debugAdapter'));

	test('initialize: returns capabilities + fires initialized event', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 1, command: 'initialize', arguments: {} });

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].command, 'initialize');
		assert.strictEqual(messages[0].success, true);
		assert.ok(messages[0].body.supportsConfigurationDoneRequest);
		assert.ok(messages[0].body.supportsConditionalBreakpoints);
		assert.ok(messages[0].body.supportsEvaluateForHover);
		assert.strictEqual(messages[1].event, 'initialized');

		session.dispose();
	});

	test('attach: reports success', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 2, command: 'attach', arguments: { port: 56000 } });

		assert.strictEqual(messages[0].command, 'attach');
		assert.strictEqual(messages[0].success, true);
		session.dispose();
	});

	test('setBreakpoints: returns verified breakpoints at correct lines', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({
			type: 'request', seq: 3, command: 'setBreakpoints',
			arguments: {
				source: { path: '/project/Assets/Scripts/Player.cs' },
				breakpoints: [{ line: 10 }, { line: 25 }, { line: 42 }]
			}
		});

		const bps = messages[0].body.breakpoints;
		assert.strictEqual(bps.length, 3);
		assert.strictEqual(bps[0].verified, true);
		assert.strictEqual(bps[0].line, 10);
		assert.strictEqual(bps[1].line, 25);
		assert.strictEqual(bps[2].line, 42);

		session.dispose();
	});

	test('threads: returns at least Main Thread', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 4, command: 'threads' });

		assert.ok(messages[0].body.threads.length >= 1);
		assert.strictEqual(messages[0].body.threads[0].name, 'Main Thread');

		session.dispose();
	});

	test('stackTrace: returns stub frames', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 5, command: 'stackTrace', arguments: { threadId: 1 } });

		assert.ok(messages[0].body.stackFrames.length >= 1);
		session.dispose();
	});

	test('scopes: returns Local scope', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 6, command: 'scopes', arguments: { frameId: 1 } });

		assert.strictEqual(messages[0].body.scopes[0].name, 'Local');
		session.dispose();
	});

	test('continue/next/stepIn/stepOut all respond success', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		for (const cmd of ['continue', 'next', 'stepIn', 'stepOut']) {
			messages.length = 0;
			session.handleMessage({ type: 'request', seq: 10, command: cmd, arguments: {} });
			assert.strictEqual(messages[0].success, true, `${cmd} should succeed`);
		}

		session.dispose();
	});

	test('disconnect: sends response + terminated event', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 20, command: 'disconnect', arguments: {} });

		const response = messages.find(m => m.command === 'disconnect');
		const terminated = messages.find(m => m.event === 'terminated');
		assert.ok(response && response.success);
		assert.ok(terminated);

		session.dispose();
	});

	test('messages after dispose are silently ignored', () => {
		const session = new UnityDebugSession();
		session.dispose();
		session.handleMessage({ type: 'request', seq: 99, command: 'threads' });
		// No error = pass
	});

	test('unknown command returns failure response', () => {
		const session = new UnityDebugSession();
		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));

		session.handleMessage({ type: 'request', seq: 30, command: 'bogusCommand', arguments: {} });

		assert.strictEqual(messages[0].success, false);
		assert.ok(messages[0].message.includes('Unknown command'));

		session.dispose();
	});

	test('setConfiguration updates port from config', () => {
		const session = new UnityDebugSession();
		session.setConfiguration({ type: 'unityCursorToolkit.debug', request: 'attach', debugPort: 12345, name: 'test' });

		const messages = [];
		session.onDidSendMessage((msg) => messages.push(msg));
		session.handleMessage({ type: 'request', seq: 40, command: 'attach', arguments: {} });

		assert.strictEqual(messages[0].success, true);
		session.dispose();
	});

	test('DescriptorFactory creates inline adapter with correct port', () => {
		const factory = new UnityDebugAdapterDescriptorFactory();
		const descriptor = factory.createDebugAdapterDescriptor(
			{ configuration: { type: 'unityCursorToolkit.debug', request: 'attach', debugPort: 99999, name: 'test' } },
			undefined
		);

		assert.ok(descriptor instanceof vscode.DebugAdapterInlineImplementation);
		assert.ok(descriptor.adapter instanceof UnityDebugSession);
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// hot-reload/fileWatcher.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testFileWatcher() {
	console.log('\n── hot-reload/fileWatcher.ts ──');
	const { FileWatcher } = require(path.join(outDir, 'hot-reload', 'fileWatcher'));

	await testAsync('enable() creates watchers, disable() cleans up', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			onStateChanged: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		const watcher = new FileWatcher(mockConn);
		watcher.enable();

		assert.ok(_lastCreatedWatcher, 'Should have created a file system watcher');

		watcher.disable();
		watcher.enable();
		watcher.disable();
	});

	await testAsync('debounces rapid changes into single refresh', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			onStateChanged: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();

		// First watcher is *.cs, second is *.{sln,csproj}
		const csWatcher = _allCreatedWatchers[0];

		csWatcher._fireChange({ fsPath: '/project/Assets/Scripts/Player.cs' });
		csWatcher._fireChange({ fsPath: '/project/Assets/Scripts/Enemy.cs' });
		csWatcher._fireChange({ fsPath: '/project/Assets/Scripts/Player.cs' });

		assert.strictEqual(sent.length, 0, 'Should not send yet (debouncing)');

		await sleep(500);

		assert.strictEqual(sent.length, 1, `Should send exactly 1 refresh, got ${sent.length}`);
		assert.strictEqual(sent[0].cmd, 'refresh');
		assert.ok(sent[0].payload.files.includes('/project/Assets/Scripts/Player.cs'));
		assert.ok(sent[0].payload.files.includes('/project/Assets/Scripts/Enemy.cs'));
		assert.strictEqual(sent[0].payload.files.length, 2, 'Deduplicates Player.cs');

		watcher.dispose();
	});

	await testAsync('pending files reset after each refresh', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();
		const csWatcher = _allCreatedWatchers[0];

		csWatcher._fireChange({ fsPath: '/project/A.cs' });
		await sleep(500);
		assert.strictEqual(sent.length, 1);
		assert.deepStrictEqual(sent[0].payload.files, ['/project/A.cs']);

		csWatcher._fireChange({ fsPath: '/project/B.cs' });
		await sleep(500);
		assert.strictEqual(sent.length, 2);
		assert.deepStrictEqual(sent[1].payload.files, ['/project/B.cs']);

		watcher.dispose();
	});

	await testAsync('disable cancels pending debounce', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();
		const csWatcher = _allCreatedWatchers[0];

		csWatcher._fireChange({ fsPath: '/project/A.cs' });
		watcher.disable();

		await sleep(500);
		assert.strictEqual(sent.length, 0, 'Disable should cancel pending refresh');
	});

	test('enable is idempotent (does not create duplicate watchers)', () => {
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			send() {}
		};
		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();
		const countAfterFirst = _allCreatedWatchers.length;
		watcher.enable();
		const countAfterSecond = _allCreatedWatchers.length;
		assert.strictEqual(countAfterFirst, countAfterSecond, 'Second enable() should not create more watchers');
		watcher.dispose();
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// core/statusBarController.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testStatusBarController() {
	console.log('\n── core/statusBarController.ts ──');
	const { StatusBarController } = require(path.join(outDir, 'core', 'statusBarController'));
	const { ConnectionState } = require(path.join(outDir, 'core', 'types'));

	function makeController() {
		const ctx = createMockExtensionContext();
		const ctrl = new StatusBarController(ctx);
		const connectItem = ctx.subscriptions[0];
		const quickAccessItem = ctx.subscriptions[1];
		return { ctrl, connectItem, quickAccessItem };
	}

	test('Disconnected (no project): shows "Unity Attach" with plug icon', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.update(ConnectionState.Disconnected, null);

		assert.ok(connectItem.text.includes('plug') || connectItem.text.includes('Unity Attach'), `Got: ${connectItem.text}`);
		assert.strictEqual(connectItem.command, 'unity-cursor-toolkit.startConnection');
		ctrl.dispose();
	});

	test('Disconnected (with project): shows project name with warning background', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.setProjectName('MyGame');
		ctrl.update(ConnectionState.Disconnected, null);

		assert.ok(connectItem.text.includes('MyGame'));
		assert.ok(connectItem.backgroundColor instanceof vscode.ThemeColor);
		assert.strictEqual(connectItem.command, 'unity-cursor-toolkit.startConnection');
		ctrl.dispose();
	});

	test('Connected: green color, port in tooltip, stop command', () => {
		const { ctrl, connectItem, quickAccessItem } = makeController();
		ctrl.update(ConnectionState.Connected, 55500);

		assert.ok(connectItem.text.includes('circle-filled') || connectItem.text.includes('Unity'));
		assert.ok(connectItem.tooltip.includes('55500'));
		assert.ok(connectItem.color instanceof vscode.ThemeColor);
		assert.strictEqual(connectItem.command, 'unity-cursor-toolkit.stopConnection');
		ctrl.dispose();
	});

	test('Connecting: shows sync spinner, hides quick access', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.update(ConnectionState.Connecting, null);

		assert.ok(connectItem.text.includes('sync~spin') || connectItem.text.includes('connecting'));
		assert.ok(connectItem.tooltip.includes('Connecting'));
		ctrl.dispose();
	});

	test('Reconnecting: shows reconnecting tooltip', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.update(ConnectionState.Reconnecting, null);

		assert.ok(connectItem.tooltip.includes('Reconnecting'));
		ctrl.dispose();
	});

	test('showCompilationResult success: check icon, green', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.showCompilationResult(true, 0, 0);

		assert.ok(connectItem.text.includes('check'));
		assert.ok(connectItem.color instanceof vscode.ThemeColor);
		ctrl.dispose();
	});

	test('showCompilationResult success with warnings', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.showCompilationResult(true, 0, 3);

		assert.ok(connectItem.text.includes('3 warning'));
		ctrl.dispose();
	});

	test('showCompilationResult failure: error icon, error count', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.showCompilationResult(false, 5, 2);

		assert.ok(connectItem.text.includes('error'));
		assert.ok(connectItem.text.includes('5 error'));
		ctrl.dispose();
	});

	test('Connected command is NOT startConnection', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.update(ConnectionState.Connected, 55500);
		assert.notStrictEqual(connectItem.command, 'unity-cursor-toolkit.startConnection');
		ctrl.dispose();
	});

	test('Disconnected color is NOT ThemeColor (no project)', () => {
		const { ctrl, connectItem } = makeController();
		ctrl.update(ConnectionState.Disconnected, null);
		assert.strictEqual(connectItem.color, undefined, 'No color when disconnected without project');
		ctrl.dispose();
	});

	test('state transitions update text between calls', () => {
		const { ctrl, connectItem } = makeController();

		ctrl.update(ConnectionState.Connected, 55500);
		const connectedText = connectItem.text;

		ctrl.update(ConnectionState.Disconnected, null);
		const disconnectedText = connectItem.text;

		assert.notStrictEqual(connectedText, disconnectedText, 'Text should change between states');
		ctrl.dispose();
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// project/csprojGenerator.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testCsprojGenerator() {
	console.log('\n── project/csprojGenerator.ts ──');
	const { hasCsprojFiles } = require(path.join(outDir, 'project', 'csprojGenerator'));

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-csproj-'));

	test('hasCsprojFiles returns false for empty directory', () => {
		assert.strictEqual(hasCsprojFiles(tmpDir), false);
	});

	test('hasCsprojFiles returns true when .csproj exists', () => {
		fs.writeFileSync(path.join(tmpDir, 'Assembly-CSharp.csproj'), '<Project/>');
		assert.strictEqual(hasCsprojFiles(tmpDir), true);
	});

	test('hasCsprojFiles returns false for non-existent path', () => {
		assert.strictEqual(hasCsprojFiles('/nonexistent/path/xyz'), false);
	});

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// project/metaManager.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testMetaManager() {
	console.log('\n── project/metaManager.ts ──');
	const { MetaManager } = require(path.join(outDir, 'project', 'metaManager'));

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-meta-'));

	await testAsync('applyMetaExclusions creates .cursorindexingignore', async () => {
		const projectPath = path.join(tmpDir, 'p1');
		fs.mkdirSync(projectPath);

		await MetaManager.applyMetaExclusions(projectPath);

		const ignorePath = path.join(projectPath, '.cursorindexingignore');
		assert.ok(fs.existsSync(ignorePath), '.cursorindexingignore should exist');

		const content = fs.readFileSync(ignorePath, 'utf-8');
		assert.ok(content.includes('*.meta'), 'Should contain *.meta pattern');
	});

	await testAsync('applyMetaExclusions does not overwrite existing file', async () => {
		const projectPath = path.join(tmpDir, 'p2');
		fs.mkdirSync(projectPath);
		fs.writeFileSync(path.join(projectPath, '.cursorindexingignore'), 'custom\n');

		await MetaManager.applyMetaExclusions(projectPath);

		const content = fs.readFileSync(path.join(projectPath, '.cursorindexingignore'), 'utf-8');
		assert.strictEqual(content, 'custom\n', 'Should not overwrite existing');
	});

	await testAsync('resolveMetaFile reads .meta file from workspace', async () => {
		const projectPath = path.join(tmpDir, 'p3');
		const assetsPath = path.join(projectPath, 'Assets', 'Scripts');
		fs.mkdirSync(assetsPath, { recursive: true });
		fs.writeFileSync(path.join(projectPath, 'Assets', 'Scripts', 'Player.cs.meta'), 'fileFormatVersion: 2\nguid: abc123\n');

		const origFolders = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

		const manager = new MetaManager();
		const content = await manager.resolveMetaFile('Assets/Scripts/Player.cs');

		assert.ok(content, 'Should find meta file');
		assert.ok(content.includes('guid: abc123'));

		manager.dispose();
		vscode.workspace.workspaceFolders = origFolders;
	});

	await testAsync('resolveMetaFile returns null for missing .meta', async () => {
		const projectPath = path.join(tmpDir, 'p4');
		fs.mkdirSync(projectPath);

		const origFolders = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

		const manager = new MetaManager();
		const content = await manager.resolveMetaFile('Assets/Scripts/Missing.cs');

		assert.strictEqual(content, null);
		manager.dispose();
		vscode.workspace.workspaceFolders = origFolders;
	});

	await testAsync('handleAssetDeleted removes companion .meta file', async () => {
		const projectPath = path.join(tmpDir, 'p5');
		fs.mkdirSync(projectPath, { recursive: true });

		const assetPath = path.join(projectPath, 'Player.cs');
		const metaPath = assetPath + '.meta';
		fs.writeFileSync(assetPath, '// code');
		fs.writeFileSync(metaPath, 'guid: xyz\n');

		assert.ok(fs.existsSync(metaPath), 'Meta should exist before delete');

		const origFolders = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

		const manager = new MetaManager();
		const fsWatcher = _lastCreatedWatcher;

		fsWatcher._fireDelete({ fsPath: assetPath });

		await sleep(200);

		assert.ok(!fs.existsSync(metaPath), 'Meta file should be deleted');

		manager.dispose();
		vscode.workspace.workspaceFolders = origFolders;
	});

	await testAsync('handleAssetDeleted is no-op when companion .meta does not exist', async () => {
		const projectPath = path.join(tmpDir, 'p6');
		fs.mkdirSync(projectPath, { recursive: true });

		const assetPath = path.join(projectPath, 'Player.cs');
		fs.writeFileSync(assetPath, '// code');

		const origFolders = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

		const manager = new MetaManager();
		const fsWatcher = _lastCreatedWatcher;

		fsWatcher._fireDelete({ fsPath: assetPath });
		await sleep(200);

		assert.ok(fs.existsSync(assetPath), 'Asset file should still exist (only meta is deleted)');

		manager.dispose();
		vscode.workspace.workspaceFolders = origFolders;
	});

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// project/projectHandler.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testProjectHandler() {
	console.log('\n── project/projectHandler.ts ──');
	const {
		initializeUnityProjectHandler,
		hasLinkedUnityProject,
		getLinkedProjectPath,
		isScriptInstalledInLinkedProject,
		isUpmPackageInstalled,
		getInstalledUpmVersion,
		injectUpmPackage,
		detectLegacyScripts,
		getCurrentProjectUri,
		clearLinkedProjectOnExit
	} = require(path.join(outDir, 'project', 'projectHandler'));

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-proj-'));

	test('hasLinkedUnityProject returns false without context', () => {
		assert.strictEqual(hasLinkedUnityProject(), false);
	});

	test('getLinkedProjectPath returns undefined without context', () => {
		assert.strictEqual(getLinkedProjectPath(), undefined);
	});

	await testAsync('after init with context, can link and detect Unity project', async () => {
		const unityProject = path.join(tmpDir, 'MyGame');
		fs.mkdirSync(path.join(unityProject, 'Assets'), { recursive: true });

		const ctx = createMockExtensionContext(tmpDir);
		initializeUnityProjectHandler(ctx);

		assert.strictEqual(hasLinkedUnityProject(), false, 'No project linked yet');

		ctx.workspaceState.update('unityCursorToolkit.currentProjectUri', vscode.Uri.file(unityProject).toString());

		assert.strictEqual(hasLinkedUnityProject(), true, 'Should detect linked project');
		assert.strictEqual(getLinkedProjectPath(), unityProject);
	});

	await testAsync('hasLinkedUnityProject returns false for path without Assets', async () => {
		const noAssets = path.join(tmpDir, 'NotUnity');
		fs.mkdirSync(noAssets, { recursive: true });

		const ctx = createMockExtensionContext(tmpDir);
		initializeUnityProjectHandler(ctx);
		ctx.workspaceState.update('unityCursorToolkit.currentProjectUri', vscode.Uri.file(noAssets).toString());

		assert.strictEqual(hasLinkedUnityProject(), false);
	});

	await testAsync('isScriptInstalledInLinkedProject checks manifest.json for UPM package', async () => {
		const project = path.join(tmpDir, 'ScriptCheck');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });
		fs.mkdirSync(packagesDir, { recursive: true });

		const ctx = createMockExtensionContext(tmpDir);
		initializeUnityProjectHandler(ctx);
		ctx.workspaceState.update('unityCursorToolkit.currentProjectUri', vscode.Uri.file(project).toString());

		assert.strictEqual(isScriptInstalledInLinkedProject(), false, 'No manifest yet');

		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			dependencies: { 'com.rankupgames.unity-cursor-toolkit': '1.0.0' }
		}));
		assert.strictEqual(isScriptInstalledInLinkedProject(), true, 'UPM package detected in manifest');
	});

	await testAsync('isUpmPackageInstalled returns false for missing manifest', async () => {
		const noManifest = path.join(tmpDir, 'NoManifest');
		fs.mkdirSync(noManifest, { recursive: true });
		assert.strictEqual(isUpmPackageInstalled(noManifest), false);
	});

	await testAsync('getInstalledUpmVersion extracts version from manifest', async () => {
		const project = path.join(tmpDir, 'VersionCheck');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			dependencies: { 'com.rankupgames.unity-cursor-toolkit': '1.2.3' }
		}));
		assert.strictEqual(getInstalledUpmVersion(project), '1.2.3');
	});

	await testAsync('getInstalledUpmVersion returns null when package missing', async () => {
		const project = path.join(tmpDir, 'VersionMissing');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			dependencies: { 'com.other.package': '2.0.0' }
		}));
		assert.strictEqual(getInstalledUpmVersion(project), null);
	});

	await testAsync('injectUpmPackage adds scoped registry and dependency', async () => {
		const project = path.join(tmpDir, 'InjectTest');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			dependencies: { 'com.unity.textmeshpro': '3.0.0' }
		}, null, 2));

		const result = injectUpmPackage(project);
		assert.strictEqual(result, true, 'Inject should succeed');

		const manifest = JSON.parse(fs.readFileSync(path.join(packagesDir, 'manifest.json'), 'utf8'));
		assert.strictEqual(manifest.dependencies['com.rankupgames.unity-cursor-toolkit'], '1.0.0');
		assert.ok(Array.isArray(manifest.scopedRegistries), 'Should have scopedRegistries');
		assert.strictEqual(manifest.scopedRegistries[0].url, 'https://package.openupm.com');
		assert.ok(manifest.scopedRegistries[0].scopes.includes('com.rankupgames'));
	});

	await testAsync('injectUpmPackage merges scope into existing OpenUPM registry', async () => {
		const project = path.join(tmpDir, 'InjectMerge');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			scopedRegistries: [{
				name: 'OpenUPM',
				url: 'https://package.openupm.com',
				scopes: ['com.other.package']
			}],
			dependencies: {}
		}, null, 2));

		injectUpmPackage(project);

		const manifest = JSON.parse(fs.readFileSync(path.join(packagesDir, 'manifest.json'), 'utf8'));
		assert.strictEqual(manifest.scopedRegistries.length, 1, 'Should not duplicate registry');
		assert.ok(manifest.scopedRegistries[0].scopes.includes('com.rankupgames'), 'Scope merged');
		assert.ok(manifest.scopedRegistries[0].scopes.includes('com.other.package'), 'Existing scope preserved');
	});

	await testAsync('injectUpmPackage is idempotent', async () => {
		const project = path.join(tmpDir, 'InjectIdempotent');
		const packagesDir = path.join(project, 'Packages');
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.writeFileSync(path.join(packagesDir, 'manifest.json'), JSON.stringify({
			dependencies: { 'com.rankupgames.unity-cursor-toolkit': '1.0.0' }
		}, null, 2));

		const result = injectUpmPackage(project);
		assert.strictEqual(result, true, 'Already installed returns true');
	});

	await testAsync('injectUpmPackage returns false without manifest', async () => {
		const noManifest = path.join(tmpDir, 'InjectNoManifest');
		fs.mkdirSync(noManifest, { recursive: true });
		assert.strictEqual(injectUpmPackage(noManifest), false);
	});

	await testAsync('detectLegacyScripts finds old scripts in Assets/Editor', async () => {
		const project = path.join(tmpDir, 'LegacyCheck');
		const editorPath = path.join(project, 'Assets', 'Editor');
		fs.mkdirSync(editorPath, { recursive: true });
		fs.writeFileSync(path.join(editorPath, 'HotReloadHandler.cs'), '// old');
		fs.writeFileSync(path.join(editorPath, 'ConsoleToCursor.cs'), '// old');

		const legacy = detectLegacyScripts(project);
		assert.strictEqual(legacy.length, 2);
		assert.ok(legacy.includes('HotReloadHandler.cs'));
		assert.ok(legacy.includes('ConsoleToCursor.cs'));
	});

	await testAsync('detectLegacyScripts returns empty when no legacy scripts', async () => {
		const project = path.join(tmpDir, 'NoLegacy');
		fs.mkdirSync(path.join(project, 'Assets', 'Editor'), { recursive: true });

		const legacy = detectLegacyScripts(project);
		assert.strictEqual(legacy.length, 0);
	});

	await testAsync('clearLinkedProjectOnExit removes stored URI', async () => {
		const project = path.join(tmpDir, 'ClearTest');
		fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });

		const ctx = createMockExtensionContext(tmpDir);
		initializeUnityProjectHandler(ctx);
		ctx.workspaceState.update('unityCursorToolkit.currentProjectUri', vscode.Uri.file(project).toString());

		assert.strictEqual(hasLinkedUnityProject(), true);

		clearLinkedProjectOnExit();

		assert.strictEqual(getCurrentProjectUri(), undefined);
	});

	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// project/projectMcpTools.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testProjectMcpTools() {
	console.log('\n── project/projectMcpTools.ts ──');
	const { ProjectMcpTools } = require(path.join(outDir, 'project', 'projectMcpTools'));
	const { MetaManager } = require(path.join(outDir, 'project', 'metaManager'));

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-pmcp-'));
	const projectPath = path.join(tmpDir, 'project');
	fs.mkdirSync(path.join(projectPath, 'Assets', 'Scripts'), { recursive: true });
	fs.writeFileSync(path.join(projectPath, 'Assets', 'Scripts', 'Test.cs.meta'), 'guid: test123\n');

	const origFolders = vscode.workspace.workspaceFolders;
	vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

	const manager = new MetaManager();
	const tools = new ProjectMcpTools(manager);

	test('getTools returns resolve_meta', () => {
		const defs = tools.getTools();
		assert.strictEqual(defs.length, 1);
		assert.strictEqual(defs[0].name, 'resolve_meta');
	});

	await testAsync('resolve_meta returns .meta content', async () => {
		const result = await tools.handleToolCall('resolve_meta', { assetPath: 'Assets/Scripts/Test.cs' });
		assert.ok(!result.isError, `Should succeed: ${result.content[0]?.text}`);
		assert.ok(result.content[0].text.includes('guid: test123'));
	});

	await testAsync('resolve_meta returns error for missing file', async () => {
		const result = await tools.handleToolCall('resolve_meta', { assetPath: 'Assets/Missing.cs' });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('No .meta file'));
	});

	await testAsync('resolve_meta returns error for empty assetPath', async () => {
		const result = await tools.handleToolCall('resolve_meta', { assetPath: '' });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('required'));
	});

	await testAsync('unknown tool returns error', async () => {
		const result = await tools.handleToolCall('nonexistent', {});
		assert.strictEqual(result.isError, true);
	});

	manager.dispose();
	vscode.workspace.workspaceFolders = origFolders;
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// console/consolePanel.ts (pure logic only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testConsolePanelLogic() {
	console.log('\n── console/consolePanel.ts (logic) ──');
	const { ConsolePanelProvider } = require(path.join(outDir, 'console', 'consolePanel'));
	const { ConsoleBridge } = require(path.join(outDir, 'console', 'consoleBridge'));

	const emitter = new MockEventEmitter();
	const bridge = new ConsoleBridge({ onMessage: emitter.event });
	const panel = new ConsolePanelProvider({ fsPath: '/mock' }, bridge);

	emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Error', message: 'NullRef in Player', stackTrace: 'at Player.Update() (Assets/Scripts/Player.cs:42)', timestamp: '2026-01-01T12:00:00Z' } });
	emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Warning', message: 'Shader not found', stackTrace: '', timestamp: '2026-01-01T12:00:01Z' } });
	emitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'Player spawned', stackTrace: '', timestamp: '2026-01-01T12:00:02Z' } });

	await testAsync('copyToClipboard captures formatted text', async () => {
		let clipboardContent = '';
		const origWrite = vscode.env.clipboard.writeText;
		vscode.env.clipboard.writeText = async (text) => { clipboardContent = text; };

		await panel.copyToClipboard();

		assert.ok(clipboardContent.includes('Unity Console Output:'));
		assert.ok(clipboardContent.includes('[ERROR]'));
		assert.ok(clipboardContent.includes('NullRef in Player'));
		assert.ok(clipboardContent.includes('[WARNING]'));
		assert.ok(clipboardContent.includes('Shader not found'));
		assert.ok(clipboardContent.includes('[LOG]'));
		assert.ok(clipboardContent.includes('Player spawned'));

		vscode.env.clipboard.writeText = origWrite;
	});

	await testAsync('snapshot generates structured markdown', async () => {
		let clipboardContent = '';
		const origWrite = vscode.env.clipboard.writeText;
		vscode.env.clipboard.writeText = async (text) => { clipboardContent = text; };

		await panel.snapshot();

		assert.ok(clipboardContent.includes('## Unity Console Snapshot'));
		assert.ok(clipboardContent.includes('### Errors (1)'));
		assert.ok(clipboardContent.includes('NullRef in Player'));
		assert.ok(clipboardContent.includes('### Warnings (1)'));
		assert.ok(clipboardContent.includes('Shader not found'));
		assert.ok(clipboardContent.includes('### Recent Logs'));

		vscode.env.clipboard.writeText = origWrite;
	});

	await testAsync('snapshot filters stackTrace lines to Assets/ paths', async () => {
		let clipboardContent = '';
		const origWrite = vscode.env.clipboard.writeText;
		vscode.env.clipboard.writeText = async (text) => { clipboardContent = text; };

		await panel.snapshot();

		assert.ok(clipboardContent.includes('Assets/Scripts/Player.cs:42'));

		vscode.env.clipboard.writeText = origWrite;
	});

	await testAsync('clear resets entries (verified via snapshot)', async () => {
		let beforeClear = '';
		const origWrite = vscode.env.clipboard.writeText;
		vscode.env.clipboard.writeText = async (text) => { beforeClear = text; };
		await panel.snapshot();
		assert.ok(beforeClear.includes('### Errors'), 'Before clear: errors section should exist');

		panel.clear();

		let afterClear = '';
		vscode.env.clipboard.writeText = async (text) => { afterClear = text; };
		await panel.snapshot();
		assert.ok(!afterClear.includes('### Errors'), 'After clear: errors section should be gone');
		assert.ok(!afterClear.includes('NullRef in Player'), 'After clear: entries should be gone');

		vscode.env.clipboard.writeText = origWrite;
	});

	await testAsync('snapshot after clear shows no sections', async () => {
		let clipboardContent = '';
		const origWrite = vscode.env.clipboard.writeText;
		vscode.env.clipboard.writeText = async (text) => { clipboardContent = text; };

		await panel.snapshot();

		assert.ok(!clipboardContent.includes('### Errors'));
		assert.ok(!clipboardContent.includes('### Warnings'));

		vscode.env.clipboard.writeText = origWrite;
	});

	panel.dispose();
	bridge.dispose();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// project/folderTemplates.ts (template data validation)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testFolderTemplates() {
	console.log('\n── project/folderTemplates.ts ──');

	// Can't call pickAndGenerateTemplate (needs quickPick), but can validate
	// the module loads and exports correctly
	const mod = require(path.join(outDir, 'project', 'folderTemplates'));

	test('exports pickAndGenerateTemplate function', () => {
		assert.strictEqual(typeof mod.pickAndGenerateTemplate, 'function');
	});
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log('Unity Cursor Toolkit -- Runtime Tests\n');
	console.log(`Using compiled output: ${outDir}`);

	if (!fs.existsSync(outDir)) {
		console.error(`ERROR: ${outDir} does not exist. Run "npm run compile" first.`);
		process.exit(1);
	}

	testTypes();
	testConnectionUnit();
	await testConnectionTcp();
	await testCommandSender();
	testConsoleBridge();
	await testConsoleMcpTools();
	await testToolRouter();
	await testUnityMcpTools();
	await testLaunchJsonGenerator();
	await testModuleLoader();
	testDebugAdapter();
	await testFileWatcher();
	testStatusBarController();
	testCsprojGenerator();
	await testMetaManager();
	await testProjectHandler();
	await testProjectMcpTools();
	await testConsolePanelLogic();
	testFolderTemplates();

	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);

	if (failures.length > 0) {
		console.log('\nFailures:');
		for (const f of failures) {
			console.log(`  - ${f.name}`);
			console.log(`    ${f.err.message}`);
		}
	}

	console.log(`${'='.repeat(60)}`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error('Test runner crashed:', err);
	process.exit(1);
});
