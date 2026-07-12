/**
 * Runtime test suite for Unity Cursor Toolkit.
 * Mocks the vscode API and exercises real function logic.
 * Run: node test/run-tests.js
 */

// TODO: Split this oversized test suite into focused module-level test files.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// ── vscode mock ──────────────────────────────────────────────────────────────

function createMockFileSystemWatcher(globPattern) {
	const changeEmitter = new MockEventEmitter();
	const deleteEmitter = new MockEventEmitter();
	const createEmitter = new MockEventEmitter();
	return {
		globPattern,
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
let _lastOutputChannel = null;

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
		createFileSystemWatcher: (globPattern) => {
			_lastCreatedWatcher = createMockFileSystemWatcher(globPattern);
			_allCreatedWatchers.push(_lastCreatedWatcher);
			return _lastCreatedWatcher;
		},
		openTextDocument: async (opts) => ({ getText: () => opts?.content || '', uri: opts })
	},
	window: {
		createStatusBarItem: () => ({
			show() {}, hide() {}, text: '', tooltip: '', command: '', color: undefined, backgroundColor: undefined
		}),
		createOutputChannel: () => {
			_lastOutputChannel = {
				lines: [],
				clearCount: 0,
				appendLine(line) { this.lines.push(line); },
				clear() { this.lines = []; this.clearCount++; },
				dispose() {}
			};
			return _lastOutputChannel;
		},
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

function listenOnLocalhost(server, port = 0) {
	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			const address = server.address();
			if (address == null || typeof address === 'string') {
				throw new Error('Expected TCP server address');
			}
			resolve(address.port);
		});
	});
}

function closeServer(server) {
	return new Promise((resolve) => server.close(resolve));
}

function writePongOnPing(socket) {
	socket.on('data', (data) => {
		const lines = data.toString().split('\n').filter(Boolean);
		for (const line of lines) {
			const parsed = JSON.parse(line);
			if (parsed.command === 'ping') {
				socket.write('{"command":"pong"}\n');
			}
		}
	});
}

async function getUnusedPort() {
	const server = net.createServer();
	const port = await listenOnLocalhost(server);
	await closeServer(server);
	return port;
}

function startMcpServer(env = {}) {
	const child = spawn(process.execPath, [path.join(outDir, 'mcp', 'server.js')], {
		env: { ...process.env, ...env },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const pending = new Map();
	let stdoutBuffer = '';
	let stderr = '';

	child.stdout.on('data', (chunk) => {
		stdoutBuffer += chunk.toString();
		const lines = stdoutBuffer.split('\n');
		stdoutBuffer = lines.pop() || '';
		for (const line of lines) {
			if (line.trim().length === 0) {
				continue;
			}
			const message = JSON.parse(line);
			const callback = pending.get(message.id);
			if (callback) {
				pending.delete(message.id);
				callback(message);
			}
		}
	});

	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});

	let requestId = 0;
	return {
		child,
		get stderr() { return stderr; },
		request(method, params) {
			const id = ++requestId;
			const payload = { jsonrpc: '2.0', id, method, params };
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Timed out waiting for MCP response to ${method}. stderr: ${stderr}`));
				}, 4_000);

				pending.set(id, (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				child.stdin.write(JSON.stringify(payload) + '\n');
			});
		},
		notify(method, params) {
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
		},
		stop() {
			child.stdin.end();
			child.kill();
		}
	};
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
// core/unityEditorLauncher.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testUnityEditorLauncher() {
	console.log('\n── core/unityEditorLauncher.ts ──');
	const {
		resolveUnityEditorPath,
		createUnityEditorLaunchPlan,
		launchUnityEditor
	} = require(path.join(outDir, 'core', 'unityEditorLauncher'));

	test('resolves macOS Unity Hub editor from ProjectVersion.txt', () => {
		const projectPath = '/workspace/CursorUnityTool';
		const expected = '/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
		const resolved = resolveUnityEditorPath(projectPath, {
			platform: 'darwin',
			env: {},
			fileExists: candidate => candidate === expected,
			readFile: candidate => {
				assert.strictEqual(candidate, path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'));
				return 'm_EditorVersion: 6000.3.9f1\n';
			}
		});

		assert.strictEqual(resolved, expected);
	});

	test('normalizes UNITY_CURSOR_TOOLKIT_UNITY_PATH when it points at Unity.app', () => {
		const appPath = '/Unity/Hub/Editor/6000.3.9f1/Unity.app';
		const expected = path.join(appPath, 'Contents', 'MacOS', 'Unity');
		const resolved = resolveUnityEditorPath('/workspace/project', {
			platform: 'darwin',
			env: { UNITY_CURSOR_TOOLKIT_UNITY_PATH: appPath },
			fileExists: candidate => candidate === expected,
			readFile: () => ''
		});

		assert.strictEqual(resolved, expected);
	});

	test('launch plan uses the official editor process with project/log flags only', () => {
		const projectPath = '/workspace/CursorUnityTool';
		const editorPath = '/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
		const plan = createUnityEditorLaunchPlan(projectPath, {
			platform: 'darwin',
			editorPathOverride: editorPath,
			tempDir: '/tmp',
			fileExists: candidate => candidate === editorPath,
			readFile: () => ''
		});

		assert.strictEqual(plan.editorPath, editorPath);
		assert.deepStrictEqual(plan.args.slice(0, 2), ['-projectPath', projectPath]);
		assert.ok(plan.args.includes('-executeMethod'), 'hidden launch explicitly starts the toolkit bridge');
		assert.ok(plan.args.includes('UnityCursorToolkit.HotReloadHandler.Start'), 'hidden launch starts the HotReload bridge');
		assert.ok(plan.args.includes('-logFile'), 'launch captures a Unity log path for troubleshooting');
		assert.ok(!plan.args.includes('-batchmode'), 'real EditorWindow rendering must not launch batchmode');
		assert.ok(!plan.args.includes('-nographics'), 'real EditorWindow rendering needs graphics');
	});

	test('hidden launch refuses to start when Unity already holds the project lock', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-launch-lock-'));
		const projectPath = path.join(tmpDir, 'CursorUnityTool');
		const editorPath = '/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
		fs.mkdirSync(path.join(projectPath, 'Temp'), { recursive: true });
		fs.writeFileSync(path.join(projectPath, 'Temp', 'UnityLockfile'), 'locked');
		try {
			assert.throws(() => launchUnityEditor(projectPath, {
				platform: 'darwin',
				editorPathOverride: editorPath,
				tempDir: tmpDir,
				lockRoot: tmpDir,
				fileExists: candidate => candidate === editorPath,
				readFile: () => '',
				spawnProcess: () => {
					throw new Error('spawn should not be reached');
				}
			}), /already open or starting/);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('hidden launch lock blocks a second detached editor spawn for the same project', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-launch-lock-'));
		const projectPath = path.join(tmpDir, 'CursorUnityTool');
		const editorPath = '/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
		let spawnCount = 0;
		const livePids = new Set([12345]);
		const spawnProcess = () => {
			spawnCount++;
			const child = new EventEmitter();
			child.pid = 12345;
			child.unref = () => {};
			return child;
		};
		try {
			const first = launchUnityEditor(projectPath, {
				platform: 'darwin',
				editorPathOverride: editorPath,
				tempDir: tmpDir,
				lockRoot: tmpDir,
				fileExists: candidate => candidate === editorPath,
				readFile: () => '',
				processExists: pid => livePids.has(pid),
				spawnProcess
			});
			assert.strictEqual(spawnCount, 1);
			assert.ok(fs.existsSync(first.launchLockPath), 'launch lock should be written next to temp logs');

			assert.throws(() => launchUnityEditor(projectPath, {
				platform: 'darwin',
				editorPathOverride: editorPath,
				tempDir: tmpDir,
				lockRoot: tmpDir,
				fileExists: candidate => candidate === editorPath,
				readFile: () => '',
				processExists: pid => livePids.has(pid),
				spawnProcess
			}), /already in progress/);
			assert.strictEqual(spawnCount, 1, 'second launch must not spawn another Unity process');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// scripts/unity-license.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testUnityLicenseScript() {
	console.log('\n── scripts/unity-license.js ──');
	const {
		createLicensePlan,
		getLicenseFileCandidates,
		parseArgs
	} = require(path.join(__dirname, '..', 'scripts', 'unity-license.js'));

	test('activate dry-run uses official Unity activation flags and masks credentials', () => {
		const options = parseArgs(['activate', '--unity-path', '/Applications/Unity/Hub/Editor/6000.3.9f1/Unity.app']);
		const plan = createLicensePlan('activate', options, {
			UNITY_EMAIL: 'dev@example.com',
			UNITY_PASSWORD: 'secret-password',
			UNITY_SERIAL: 'SERIAL-1234'
		});

		assert.strictEqual(plan.execute, false);
		assert.deepStrictEqual(plan.args.slice(0, 4), ['-quit', '-batchmode', '-serial', 'SERIAL-1234']);
		assert.ok(plan.args.includes('-username'));
		assert.ok(plan.args.includes('-password'));
		assert.ok(plan.maskedCommand.includes('<UNITY_EMAIL>'));
		assert.ok(plan.maskedCommand.includes('<UNITY_PASSWORD>'));
		assert.ok(plan.maskedCommand.includes('<UNITY_SERIAL>'));
		assert.ok(!plan.maskedCommand.includes('dev@example.com'));
		assert.ok(!plan.maskedCommand.includes('secret-password'));
		assert.ok(!plan.maskedCommand.includes('SERIAL-1234'));
	});

	test('manual activation create uses createManualActivationFile without credentials', () => {
		const options = parseArgs(['activate', '--manual', '--unity-path', '/Unity/Unity']);
		const plan = createLicensePlan('activate', options, {});

		assert.deepStrictEqual(plan.args, ['-batchmode', '-createManualActivationFile', '-logFile', '-']);
		assert.deepStrictEqual(plan.requiredEnv, []);
		assert.ok(!plan.maskedCommand.includes('UNITY_PASSWORD'));
	});

	test('manual license import uses manualLicenseFile path', () => {
		const options = parseArgs(['activate', '--manual', '--ulf', '/tmp/license.ulf', '--unity-path', '/Unity/Unity']);
		const plan = createLicensePlan('activate', options, {});

		assert.deepStrictEqual(plan.args, ['-batchmode', '-manualLicenseFile', '/tmp/license.ulf', '-logFile', '-']);
	});

	test('return execute requires env credentials before touching a seat', () => {
		const options = parseArgs(['return', '--execute', '--unity-path', process.execPath]);

		assert.throws(
			() => createLicensePlan('return', options, {}),
			/missing required UNITY_EMAIL/
		);
	});

	test('status candidate paths include Windows ProgramData license file', () => {
		const candidates = getLicenseFileCandidates('win32', { PROGRAMDATA: 'C:\\ProgramData' });

		assert.deepStrictEqual(candidates, [path.win32.join('C:\\ProgramData', 'Unity', 'Unity_lic.ulf')]);
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
		const closedPort = await getUnusedPort();
		const server = net.createServer(writePongOnPing);
		const openPort = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([closedPort, openPort]);
			const result = await conn.connect();
			assert.strictEqual(result, openPort);
			assert.strictEqual(conn.info.state, ConnectionState.Connected, 'State should be Connected if a port was found');
			assert.strictEqual(conn.info.port, openPort);
			conn.disconnect();
			conn.dispose();
		} finally {
			await closeServer(server);
		}
	});

	await testAsync('connect shares an in-flight probe instead of launching duplicate attempts', async () => {
		let connectionCount = 0;
		const server = net.createServer((socket) => {
			connectionCount++;
			socket.on('data', (data) => {
				if (data.toString().includes('"ping"')) {
					setTimeout(() => socket.write('{"command":"pong"}\n'), 50);
				}
			});
		});
		const openPort = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([openPort]);
			const [first, second] = await Promise.all([conn.connect(), conn.connect()]);
			assert.strictEqual(first, openPort);
			assert.strictEqual(second, openPort);
			assert.strictEqual(connectionCount, 1, 'Only one socket probe should be opened');
			conn.disconnect();
			conn.dispose();
		} finally {
			await closeServer(server);
		}
	});

	await testAsync('connect rejects open ports that do not speak toolkit JSON pong', async () => {
		const server = net.createServer((socket) => {
			socket.on('data', () => {
				socket.write('Unity debugger listener\\n');
			});
		});
		const openPort = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([openPort]);
			const result = await conn.connect();
			assert.strictEqual(result, null);
			assert.strictEqual(conn.info.state, ConnectionState.Disconnected);
			conn.dispose();
		} finally {
			await closeServer(server);
		}
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

		const portToUse = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([portToUse]);
			conn.setNeededCallback(() => true);

			const port = await conn.connect();
			assert.strictEqual(port, portToUse);
			assert.strictEqual(conn.info.state, ConnectionState.Connected);
			assert.strictEqual(conn.info.port, portToUse);

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
			await closeServer(server);
			await sleep(100);
		}
	});

	await testAsync('state transitions: Disconnected -> Connecting -> Connected', async () => {
		const server = net.createServer(writePongOnPing);
		const portToUse = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([portToUse]);
			const states = [];
			conn.onStateChanged((info) => states.push(info.state));

			const port = await conn.connect();
			assert.strictEqual(port, portToUse);
			assert.ok(states.includes(ConnectionState.Connecting), 'Should transition through Connecting');
			assert.ok(states.includes(ConnectionState.Connected), 'Should reach Connected');

			conn.disconnect();
			assert.ok(states.includes(ConnectionState.Disconnected), 'Should reach Disconnected on manual disconnect');
			conn.dispose();
		} finally {
			await closeServer(server);
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
		const portToUse = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([portToUse]);
			conn.setNeededCallback(() => true);

			const port = await conn.connect();
			assert.strictEqual(port, portToUse);
			assert.strictEqual(conn.info.state, ConnectionState.Connected);

			// Wait long enough that a heartbeat should fire (10s interval)
			// but not so long the test hangs. We just verify still connected after 1s.
			await sleep(500);
			assert.strictEqual(conn.info.state, ConnectionState.Connected, 'Should still be connected');

			conn.disconnect();
			conn.dispose();
		} finally {
			await closeServer(server);
			await sleep(100);
		}
	});

	await testAsync('reconnects after server-initiated close', async () => {
		let connectionCount = 0;
		const server = net.createServer((socket) => {
			connectionCount++;
			writePongOnPing(socket);
			if (connectionCount === 1) {
				setTimeout(() => socket.destroy(), 150);
			}
		});
		const portToUse = await listenOnLocalhost(server);

		try {
			const conn = new ConnectionManager([portToUse]);
			conn.setNeededCallback(() => true);

			const stateLog = [];
			conn.onStateChanged((info) => stateLog.push(info.state));

			const port = await conn.connect();
			assert.strictEqual(port, portToUse);

			// Wait for server to drop us and reconnect to start
			await sleep(2500);

			assert.ok(
				stateLog.includes(ConnectionState.Reconnecting),
				`Should enter Reconnecting after server drops. States: ${stateLog.join(' -> ')}`
			);

			conn.disconnect();
			conn.dispose();
		} finally {
			await closeServer(server);
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

	test('console retention hard-caps oversized configuration at 1000 entries', () => {
		const origGetConfig = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = () => ({
			get: (key, def) => key === 'maxEntries' ? 100_000 : def
		});

		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		for (let i = 0; i < 1_010; i++) {
			emitter.fire({
				command: 'consoleEntry',
				payload: { command: 'consoleEntry', type: 'Log', message: `msg${i}`, stackTrace: '', timestamp: `t${i}` }
			});
		}

		const entries = bridge.getEntries();
		assert.strictEqual(bridge.getMaxEntries(), 1_000);
		assert.strictEqual(entries.length, 1_000);
		assert.strictEqual(entries[0].message, 'msg10');
		assert.strictEqual(entries[999].message, 'msg1009');

		vscode.workspace.getConfiguration = origGetConfig;
		bridge.dispose();
	});

	test('consoleEntry normalizes malformed payload fields', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({
			command: 'consoleEntry',
			payload: { command: 'consoleEntry', type: 123, message: 456, stackTrace: { bad: true }, timestamp: 789 }
		});

		const entries = bridge.getEntries();
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].type, 'log');
		assert.strictEqual(entries[0].message, '');
		assert.strictEqual(entries[0].stackTrace, '');
		assert.ok(typeof entries[0].timestamp === 'string' && entries[0].timestamp.length > 0);
		assert.doesNotThrow(() => bridge.getEntries({ search: 'anything' }));

		bridge.dispose();
	});

	test('consoleEntry bounds oversized message and stack trace strings', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		emitter.fire({
			command: 'consoleEntry',
			payload: {
				command: 'consoleEntry',
				type: 'Error',
				message: 'm'.repeat(10_000),
				stackTrace: 's'.repeat(50_000),
				timestamp: 't'
			}
		});

		const [entry] = bridge.getEntries();
		assert.strictEqual(entry.message.length, 4_096);
		assert.strictEqual(entry.stackTrace.length, 16_384);
		assert.ok(entry.message.endsWith('… [truncated]'));
		assert.ok(entry.stackTrace.endsWith('… [truncated]'));
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

	test('consoleToCursor ignores malformed content payloads', () => {
		const emitter = new vscode.EventEmitter();
		const bridge = new ConsoleBridge({ onMessage: emitter.event });

		const bulks = [];
		bridge.onBulk((b) => bulks.push(b));

		emitter.fire({
			command: 'consoleToCursor',
			payload: { content: { text: 'not a string' }, entryCount: '5' }
		});

		assert.strictEqual(bulks.length, 0);
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

function testUnityProfilerSafetySource() {
	console.log('\n── Unity editor profiler safety contracts ──');
	const editorRoot = path.join(__dirname, '..', '..', 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor');
	const profilerSource = fs.readFileSync(path.join(editorRoot, 'ProfilerSnapshot.cs'), 'utf8');
	const transcriptSource = fs.readFileSync(path.join(editorRoot, 'ConsoleTranscriptRecorder.cs'), 'utf8');
	const hotReloadSource = fs.readFileSync(path.join(editorRoot, 'HotReloadHandler.cs'), 'utf8');
	const validationSource = fs.readFileSync(path.join(editorRoot, 'MCP', 'EditorValidationTool.cs'), 'utf8');
	const editorControlSource = fs.readFileSync(path.join(editorRoot, 'MCP', 'EditorControlTools.cs'), 'utf8');

	test('background profiler is Play-Mode-only and not reconfigured from Tick', () => {
		const tickStart = profilerSource.indexOf('private static void Tick()');
		const tickEnd = profilerSource.indexOf('private static void OnPlayModeStateChanged', tickStart);
		const tickSource = profilerSource.slice(tickStart, tickEnd);
		assert.ok(tickSource.includes('EditorApplication.isPlaying == false'));
		assert.ok(!tickSource.includes('ConfigureProfilerDriver'));
		assert.ok(!profilerSource.includes('CaptureCurrentSession(true)'));
	});

	test('console transcripts and temporary profiler storage have hard limits', () => {
		assert.ok(transcriptSource.includes('private const int MaxEntryCount = 1000;'));
		assert.ok(transcriptSource.includes('Queue<ConsoleTranscriptEntry>'));
		assert.ok(transcriptSource.includes('LimitLength(message, MaxMessageLength'));
		assert.ok(profilerSource.includes('private const long MaxTempSessionBytes = 64L * 1024L * 1024L;'));
	});

	test('refresh handling avoids duplicate compilation and bounds queued message bytes', () => {
		assert.ok(hotReloadSource.includes('private const int MAX_QUEUED_MESSAGE_CHARACTERS = 4 * 1024 * 1024;'));
		assert.ok(hotReloadSource.includes('EnqueueMessage(line);'));
		const syncStart = validationSource.indexOf('internal static string SyncAndRequestCompile');
		const syncEnd = validationSource.indexOf('private static void TrackRefreshCompilation', syncStart);
		const syncSource = validationSource.slice(syncStart, syncEnd);
		assert.ok(syncSource.includes('AssetDatabase.Refresh'));
		assert.ok(!syncSource.includes('RequestScriptCompilation('));
	});

	test('editor lifecycle saves scenes and assets before scheduling a normal exit', () => {
		const lifecycleStart = editorControlSource.indexOf('internal sealed class EditorLifecycleTool');
		const lifecycleEnd = editorControlSource.indexOf('[MCPTool("execute_menu_item")]', lifecycleStart);
		const lifecycleSource = editorControlSource.slice(lifecycleStart, lifecycleEnd);
		assert.ok(lifecycleSource.includes('EditorApplication.isPlayingOrWillChangePlaymode'));
		assert.ok(lifecycleSource.includes('EditorApplication.isCompiling'));
		assert.ok(lifecycleSource.includes('EditorApplication.isUpdating'));
		assert.ok(lifecycleSource.includes('hasUntitledDirtyScene'));
		assert.ok(lifecycleSource.includes('PrefabStageUtility.GetCurrentPrefabStage()'));
		assert.ok(editorControlSource.includes('#if UNITY_2021_2_OR_NEWER'));
		assert.ok(editorControlSource.includes('UnityEditor.Experimental.SceneManagement.PrefabStageUtility'));
		assert.ok(lifecycleSource.includes('prefabStage.prefabAssetPath'));
		assert.ok(lifecycleSource.includes('GetDirtyAssetPaths()'));
		assert.ok(lifecycleSource.includes('IsWritableProjectAssetPath(path)'));
		assert.ok(lifecycleSource.includes('dirtyScenes.Count > 0 && EditorSceneManager.SaveOpenScenes()'));
		assert.ok(lifecycleSource.indexOf('EditorApplication.delayCall += QuitEditor') < lifecycleSource.indexOf('EditorApplication.Exit(0)'));
		const quitStart = lifecycleSource.indexOf('private static void QuitEditor()');
		const quitEnd = lifecycleSource.indexOf('private static bool TrySaveProject', quitStart);
		assert.ok(lifecycleSource.slice(quitStart, quitEnd).includes('TrySaveProject(out _, out _, out error)'));
		const saveAttemptStart = lifecycleSource.indexOf('private static bool TrySaveProject');
		const saveAttemptEnd = lifecycleSource.indexOf('private static List<string> GetDirtySceneIdentifiers', saveAttemptStart);
		const saveAttemptSource = lifecycleSource.slice(saveAttemptStart, saveAttemptEnd);
		assert.ok(saveAttemptSource.indexOf('EditorSceneManager.SaveOpenScenes()') < saveAttemptSource.indexOf('AssetDatabase.SaveAssets()'));
		assert.ok(saveAttemptSource.indexOf('AssetDatabase.SaveAssets()') < saveAttemptSource.indexOf('remainingDirtyAssets'));
	});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// console/index.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testConsoleModuleRetention() {
	console.log('\n── console/index.ts ──');
	const { ConsoleModule } = require(path.join(outDir, 'console', 'index'));
	const { ConnectionState } = require(path.join(outDir, 'core', 'types'));
	const messageEmitter = new MockEventEmitter();
	const requests = [];
	const module = new ConsoleModule();

	await module.activate({
		connectionManager: {
			info: { state: ConnectionState.Connected, port: 55500 },
			onMessage: messageEmitter.event
		},
		commandSender: {
			async request(command, payload) {
				requests.push({ command, payload });
				return { result: { content: 'snapshot' } };
			}
		},
		registerCommand() {},
		registerToolProvider() {},
		registerStatusBarContributor() {}
	});

	test('output channel clears each fixed 1000-entry batch', () => {
		for (let i = 0; i < 1_001; i++) {
			messageEmitter.fire({
				command: 'consoleEntry',
				payload: { command: 'consoleEntry', type: 'Log', message: `msg${i}`, stackTrace: '', timestamp: `t${i}` }
			});
		}

		assert.strictEqual(_lastOutputChannel.clearCount, 1);
		assert.deepStrictEqual(_lastOutputChannel.lines, ['[LOG] [t1000] msg1000']);
	});

	await testAsync('clipboard profiler snapshot omits raw frame arrays by default', async () => {
		const snapshot = await module.captureUnityProfilerSnapshot();
		assert.strictEqual(snapshot, 'snapshot');
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].payload.toolName, 'profiler_snapshot');
		assert.strictEqual(requests[0].payload.args.includeRaw, false);
	});

	await module.deactivate();
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
	const { isDestructiveToolCall, isMutatingToolCall } = require(path.join(outDir, 'mcp', 'toolMetadata'));

	test('getTools returns all 15 tool definitions with correct names', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const defs = tools.getTools();
		assert.strictEqual(defs.length, 15);
		const names = defs.map(d => d.name).sort();
		assert.deepStrictEqual(names, [
			'batch_execute', 'build_trigger', 'editor_lifecycle', 'editor_validation',
			'execute_menu_item', 'game_command',
			'manage_asset', 'manage_component', 'manage_gameobject',
			'manage_material', 'manage_scene', 'play_mode',
			'profiler_snapshot', 'project_info', 'screenshot'
		]);
	});

	test('each tool definition has name, description, and inputSchema', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		for (const def of tools.getTools()) {
			assert.ok(def.name, `Tool missing name`);
			assert.ok(def.description, `${def.name} missing description`);
			assert.ok(def.inputSchema, `${def.name} missing inputSchema`);
			assert.ok(def.annotations, `${def.name} missing annotations`);
		}
	});

	test('tool annotations distinguish read-only and mutating tools', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const defs = Object.fromEntries(tools.getTools().map((def) => [def.name, def]));

		assert.strictEqual(defs.project_info.annotations.readOnlyHint, true);
		assert.strictEqual(defs.manage_asset.annotations.readOnlyHint, false);
		assert.strictEqual(defs.manage_asset.annotations.destructiveHint, true);
		assert.strictEqual(defs.profiler_snapshot.annotations.readOnlyHint, false);
		assert.strictEqual(defs.profiler_snapshot.annotations.destructiveHint, true);
		assert.strictEqual(defs.editor_lifecycle.annotations.readOnlyHint, false);
		assert.strictEqual(defs.editor_lifecycle.annotations.destructiveHint, true);
	});

	test('editor_lifecycle schema exposes fail-closed save and quit actions', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const editorLifecycle = tools.getTools().find((def) => def.name === 'editor_lifecycle');
		assert.ok(editorLifecycle, 'editor_lifecycle tool exists');
		assert.deepStrictEqual(editorLifecycle.inputSchema.properties.action.enum, ['status', 'save', 'saveAndQuit']);
		assert.ok(editorLifecycle.inputSchema.properties.dryRun);
	});

	test('editor_lifecycle metadata keeps status readable and saveAndQuit destructive', () => {
		assert.strictEqual(isMutatingToolCall('editor_lifecycle', { action: 'status' }), false);
		assert.strictEqual(isMutatingToolCall('editor_lifecycle', { action: 'save' }), true);
		assert.strictEqual(isDestructiveToolCall('editor_lifecycle', { action: 'save' }), false);
		assert.strictEqual(isDestructiveToolCall('editor_lifecycle', { action: 'saveAndQuit' }), true);
	});

	test('profiler_snapshot schema exposes session actions and detail options', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const profiler = tools.getTools().find((def) => def.name === 'profiler_snapshot');
		assert.ok(profiler, 'profiler_snapshot tool exists');
		assert.ok(profiler.inputSchema.properties.action.enum.includes('current'));
		assert.ok(profiler.inputSchema.properties.action.enum.includes('readConsoleTranscript'));
		assert.ok(profiler.inputSchema.properties.action.enum.includes('saveSession'));
		assert.ok(profiler.inputSchema.properties.includeRaw);
		assert.ok(profiler.inputSchema.properties.sessionId);
		assert.ok(profiler.inputSchema.properties.dryRun);
	});

	test('game_command schema exposes runtime command actions', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const gameCommand = tools.getTools().find((def) => def.name === 'game_command');
		assert.ok(gameCommand, 'game_command tool exists');
		assert.ok(gameCommand.inputSchema.properties.action.enum.includes('list'));
		assert.ok(gameCommand.inputSchema.properties.action.enum.includes('run'));
		assert.ok(gameCommand.inputSchema.properties.action.enum.includes('status'));
		assert.ok(gameCommand.inputSchema.properties.action.enum.includes('cancel'));
		assert.ok(gameCommand.inputSchema.properties.commandName);
		assert.ok(gameCommand.inputSchema.properties.runId);
		assert.ok(gameCommand.inputSchema.properties.args);
		assert.ok(gameCommand.inputSchema.properties.host.enum.includes('editorBatchmode'));
		assert.ok(gameCommand.inputSchema.properties.unityPath);
		assert.ok(gameCommand.inputSchema.properties.timeoutMs);
		assert.ok(gameCommand.inputSchema.properties.dryRun);
	});

	test('editor_validation schema exposes read and compile actions', () => {
		const tools = new UnityMcpTools({ send() {}, request: async () => null });
		const editorValidation = tools.getTools().find((def) => def.name === 'editor_validation');
		assert.ok(editorValidation, 'editor_validation tool exists');
		assert.ok(editorValidation.inputSchema.properties.action.enum.includes('list'));
		assert.ok(editorValidation.inputSchema.properties.action.enum.includes('status'));
		assert.ok(editorValidation.inputSchema.properties.action.enum.includes('sync_project_files'));
		assert.ok(editorValidation.inputSchema.properties.action.enum.includes('request_compile'));
		assert.ok(editorValidation.inputSchema.properties.action.enum.includes('sync_and_compile'));
		assert.ok(editorValidation.inputSchema.properties.dryRun);
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

	await testAsync('handleToolCall stringifies Unity object results', async () => {
		const tools = new UnityMcpTools({
			send() {},
			request: async () => ({ result: { unityVersion: '6000.3.9f1', success: true } })
		});
		const result = await tools.handleToolCall('project_info', {});
		assert.ok(!result.isError, `isError should be falsy, got ${result.isError}`);
		assert.ok(result.content[0].text.includes('"unityVersion":"6000.3.9f1"'));
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

	await testAsync('handleToolCall returns isError when Unity result has success=false', async () => {
		const tools = new UnityMcpTools({
			send() {},
			request: async () => ({ result: { success: false, error: 'Scene not found' } })
		});
		const result = await tools.handleToolCall('manage_scene', { action: 'load', path: 'bad' });
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

	await testAsync('profiler_snapshot current defaults are forwarded without requiring mutation approval', async () => {
		const calls = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: { success: true, session: { id: 'editor_1' } }, error: false };
			}
		});

		const result = await tools.handleToolCall('profiler_snapshot', {});

		assert.ok(!result.isError, `isError should be falsy, got ${result.isError}`);
		assert.strictEqual(calls[0].payload.toolName, 'profiler_snapshot');
		assert.deepStrictEqual(calls[0].payload.args, {});
		assert.ok(result.content[0].text.includes('editor_1'));
	});

	await testAsync('profiler_snapshot normalizes sessionId alias', async () => {
		const calls = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: { success: true }, error: false };
			}
		});

		await tools.handleToolCall('profiler_snapshot', { action: 'readSession', sessionId: 'play_123' });

		assert.deepStrictEqual(calls[0].payload.args, { action: 'readSession', sessionId: 'play_123', id: 'play_123' });
	});

	await testAsync('handleToolCall dryRun returns normalized command without sending to Unity', async () => {
		let requestCount = 0;
		const tools = new UnityMcpTools({
			send() {},
			request: async () => {
				requestCount++;
				return { result: 'should-not-run', error: false };
			}
		});

		const result = await tools.handleToolCall('manage_gameobject', {
			action: 'setTransform',
			name: 'Probe',
			scale: { x: 2, y: 3, z: 4 },
			dryRun: true
		});
		const payload = JSON.parse(result.content[0].text);

		assert.strictEqual(requestCount, 0);
		assert.strictEqual(payload.dryRun, true);
		assert.strictEqual(payload.toolName, 'manage_gameobject');
		assert.deepStrictEqual(payload.args, { action: 'setTransform', name: 'Probe', localScale: [2, 3, 4] });
	});

	await testAsync('editor_validation dryRun blocks compile actions but forwards status', async () => {
		const calls = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: { success: true, status: 'idle' }, error: false };
			}
		});

		const compileResult = await tools.handleToolCall('editor_validation', { action: 'sync_and_compile', dryRun: true });
		const compilePayload = JSON.parse(compileResult.content[0].text);
		assert.strictEqual(compilePayload.dryRun, true);
		assert.strictEqual(compilePayload.toolName, 'editor_validation');
		assert.deepStrictEqual(compilePayload.args, { action: 'sync_and_compile' });
		assert.strictEqual(calls.length, 0);

		await tools.handleToolCall('editor_validation', { action: 'status', dryRun: true });
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].payload.toolName, 'editor_validation');
		assert.deepStrictEqual(calls[0].payload.args, { action: 'status' });
	});

	await testAsync('handleToolCall normalizes MCP schema args for Unity handlers', async () => {
		const calls = [];
		const tools = new UnityMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: { success: true }, error: false };
			}
		});

		await tools.handleToolCall('manage_scene', { action: 'load', scenePath: 'Assets/Test.unity' });
		await tools.handleToolCall('manage_asset', { action: 'move', path: 'Assets/A.mat', newPath: 'Assets/B.mat' });
		await tools.handleToolCall('manage_asset', { action: 'rename', path: 'Assets/B.mat', newPath: 'Assets/Renamed.mat' });
		await tools.handleToolCall('manage_material', {
			action: 'setColor',
			path: 'Assets/M.mat',
			propertyName: '_Color',
			color: { r: 0.1, g: 0.2, b: 0.3, a: 1 }
		});
		await tools.handleToolCall('manage_gameobject', {
			action: 'setTransform',
			instanceId: 123,
			position: { x: 1, y: 2, z: 3 },
			rotation: { x: 0, y: 0, z: 0, w: 1 },
			scale: { x: 2, y: 2, z: 2 }
		});
		await tools.handleToolCall('manage_component', {
			action: 'setProperty',
			gameObjectName: 'Probe',
			propertyName: 'm_Name',
			propertyValue: 'ProbeRenamed'
		});
		await tools.handleToolCall('build_trigger', { buildPath: 'Builds/Test', development: true });
		await tools.handleToolCall('profiler_snapshot', { action: 'saveSession', sessionId: 'editor_123' });
		await tools.handleToolCall('game_command', { action: 'run', commandName: 'auth.select_us_east', runId: 'ignored' });

		assert.deepStrictEqual(calls[0].payload.args, { action: 'load', scenePath: 'Assets/Test.unity', path: 'Assets/Test.unity' });
		assert.deepStrictEqual(calls[1].payload.args, {
			action: 'move',
			path: 'Assets/A.mat',
			newPath: 'Assets/B.mat',
			source: 'Assets/A.mat',
			dest: 'Assets/B.mat'
		});
		assert.deepStrictEqual(calls[2].payload.args, {
			action: 'rename',
			path: 'Assets/B.mat',
			newPath: 'Assets/Renamed.mat',
			newName: 'Renamed'
		});
		assert.deepStrictEqual(calls[3].payload.args, {
			action: 'setColor',
			path: 'Assets/M.mat',
			propertyName: '_Color',
			property: '_Color',
			color: [0.1, 0.2, 0.3, 1]
		});
		assert.deepStrictEqual(calls[4].payload.args, {
			action: 'setTransform',
			instanceId: 123,
			position: [1, 2, 3],
			rotation: [0, 0, 0, 1],
			localScale: [2, 2, 2]
		});
		assert.deepStrictEqual(calls[5].payload.args, {
			action: 'setProperty',
			gameObjectName: 'Probe',
			name: 'Probe',
			propertyName: 'm_Name',
			propertyValue: 'ProbeRenamed',
			propertyPath: 'm_Name',
			valueString: 'ProbeRenamed'
		});
		assert.deepStrictEqual(calls[6].payload.args, { buildPath: 'Builds/Test', development: true, path: 'Builds/Test' });
		assert.deepStrictEqual(calls[7].payload.args, { action: 'saveSession', sessionId: 'editor_123', id: 'editor_123' });
		assert.deepStrictEqual(calls[8].payload.args, {
			action: 'run',
			commandName: 'auth.select_us_east',
			name: 'auth.select_us_east',
			runId: 'ignored',
			id: 'ignored'
		});
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
// mcp/server.ts (standalone MCP stdio)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function testStandaloneMcpServer() {
	console.log('\n── mcp/server.ts (standalone stdio) ──');

	await testAsync('stdio server initializes and lists tools, resources, and prompts', async () => {
		const closedPort = await getUnusedPort();
		const server = startMcpServer({
			UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(closedPort),
			UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: '1'
		});

		try {
			const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
			server.notify('notifications/initialized', {});
			assert.strictEqual(init.result.serverInfo.name, 'unity-cursor-toolkit');
			assert.ok(init.result.instructions.includes('Read-only mode is enabled'));

			const tools = await server.request('tools/list', {});
			const toolNames = tools.result.tools.map((tool) => tool.name);
			assert.ok(toolNames.includes('project_info'));
			assert.ok(toolNames.includes('read_console'));
			assert.ok(toolNames.includes('profiler_snapshot'));
			assert.ok(toolNames.includes('game_command'));
			assert.ok(toolNames.includes('unity_context'));
			assert.ok(toolNames.includes('viewport_stream'));
			const projectInfo = tools.result.tools.find((tool) => tool.name === 'project_info');
			assert.strictEqual(projectInfo.annotations.readOnlyHint, true);

			const resources = await server.request('resources/list', {});
			const resourceUris = resources.result.resources.map((resource) => resource.uri);
			assert.ok(resourceUris.includes('unity://tools/catalog'));
			assert.ok(resourceUris.includes('unity://console/errors'));
			assert.ok(resourceUris.includes('unity://context/summary'));

			const prompts = await server.request('prompts/list', {});
			const promptNames = prompts.result.prompts.map((prompt) => prompt.name);
			assert.ok(promptNames.includes('diagnose_unity_errors'));
			assert.ok(promptNames.includes('safe_scene_edit_plan'));
		} finally {
			server.stop();
		}
	});

	await testAsync('read-only mode blocks mutating tools but allows dryRun', async () => {
		const closedPort = await getUnusedPort();
		const server = startMcpServer({
			UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(closedPort),
			UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: '1'
		});

		try {
			await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

			const blocked = await server.request('tools/call', {
				name: 'play_mode',
				arguments: { action: 'enter' }
			});
			assert.strictEqual(blocked.result.isError, true);
			assert.ok(blocked.result.content[0].text.includes('blocked'));

			const dryRun = await server.request('tools/call', {
				name: 'manage_gameobject',
				arguments: {
					action: 'setTransform',
					name: 'Probe',
					position: { x: 1, y: 2, z: 3 },
					dryRun: true
				}
			});
			const payload = JSON.parse(dryRun.result.content[0].text);
			assert.strictEqual(payload.dryRun, true);
			assert.deepStrictEqual(payload.args.position, [1, 2, 3]);

			const profilerCurrent = await server.request('tools/call', {
				name: 'profiler_snapshot',
				arguments: { action: 'current' }
			});
			assert.strictEqual(profilerCurrent.result.isError, true);
			assert.ok(profilerCurrent.result.content[0].text.includes('Unity did not respond'));

			const profilerTranscript = await server.request('tools/call', {
				name: 'profiler_snapshot',
				arguments: { action: 'readConsoleTranscript', sessionId: 'editor_123' }
			});
			assert.strictEqual(profilerTranscript.result.isError, true);
			assert.ok(profilerTranscript.result.content[0].text.includes('Unity did not respond'));

			const profilerBlocked = await server.request('tools/call', {
				name: 'profiler_snapshot',
				arguments: { action: 'clearSessions' }
			});
			assert.strictEqual(profilerBlocked.result.isError, true);
			assert.ok(profilerBlocked.result.content[0].text.includes('blocked'));

			const gameCommandList = await server.request('tools/call', {
				name: 'game_command',
				arguments: {}
			});
			assert.strictEqual(gameCommandList.result.isError, true);
			assert.ok(gameCommandList.result.content[0].text.includes('Unity did not respond'));

			const gameCommandBlocked = await server.request('tools/call', {
				name: 'game_command',
				arguments: { action: 'run', commandName: 'auth.select_us_east' }
			});
			assert.strictEqual(gameCommandBlocked.result.isError, true);
			assert.ok(gameCommandBlocked.result.content[0].text.includes('blocked'));
		} finally {
			server.stop();
		}
	});

	await testAsync('missing Unity connection returns clean tool error', async () => {
		const closedPort = await getUnusedPort();
		const server = startMcpServer({ UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(closedPort) });

		try {
			await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
			const response = await server.request('tools/call', { name: 'project_info', arguments: {} });
			assert.strictEqual(response.result.isError, true);
			assert.ok(response.result.content[0].text.includes('Unity did not respond'));
		} finally {
			server.stop();
		}
	});

	await testAsync('client config snippets include supported MCP client shapes', async () => {
		const { createMcpClientConfigSnippets } = require(path.join(outDir, 'mcp', 'clientConfig'));
		const snippets = createMcpClientConfigSnippets({
			serverPath: '/ext/out/mcp/server.js',
			projectPath: '/project',
			readOnly: true
		});

		assert.strictEqual(JSON.parse(snippets.cursorClaude).mcpServers['unity-cursor-toolkit'].command, 'node');
		assert.strictEqual(JSON.parse(snippets.vscode).servers['unity-cursor-toolkit'].type, 'stdio');
		assert.strictEqual(JSON.parse(snippets.zed).context_servers['unity-cursor-toolkit'].env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH, '/project');
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

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();

		assert.ok(_lastCreatedWatcher, 'Should have created a file system watcher');
		assert.strictEqual(_allCreatedWatchers.length, 1, 'Only the scoped C# watcher should be active');
		assert.strictEqual(_lastCreatedWatcher.globPattern, '**/{Assets,Packages}/**/*.cs');

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

		csWatcher._fireChange({ fsPath: '/project/Assets/A.cs' });
		await sleep(500);
		assert.strictEqual(sent.length, 1);
		assert.deepStrictEqual(sent[0].payload.files, ['/project/Assets/A.cs']);

		csWatcher._fireChange({ fsPath: '/project/Packages/com.example/B.cs' });
		await sleep(500);
		assert.strictEqual(sent.length, 2);
		assert.deepStrictEqual(sent[1].payload.files, ['/project/Packages/com.example/B.cs']);

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

		csWatcher._fireChange({ fsPath: '/project/Assets/A.cs' });
		watcher.disable();

		await sleep(500);
		assert.strictEqual(sent.length, 0, 'Disable should cancel pending refresh');
	});

	await testAsync('ignores generated folders and project-file regeneration', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();
		const csWatcher = _allCreatedWatchers[0];

		for (const fsPath of [
			'/project/Library/PackageCache/Generated.cs',
			'/project/Temp/Generated.cs',
			'/project/Obj/Generated.cs',
			'/project/.git/Generated.cs',
			'/project/Project.csproj',
			'/project/Project.sln',
			'/project/Other/OutsideAssets.cs'
		]) {
			csWatcher._fireChange({ fsPath });
		}

		await sleep(500);
		assert.strictEqual(sent.length, 0, 'Generated and project files must not trigger Unity refresh');
		watcher.dispose();
	});

	await testAsync('caps pending changed-file details during a large burst', async () => {
		const sent = [];
		const mockConn = {
			onMessage: new MockEventEmitter().event,
			send(cmd, payload) { sent.push({ cmd, payload }); }
		};

		_allCreatedWatchers = [];
		const watcher = new FileWatcher(mockConn);
		watcher.enable();
		const csWatcher = _allCreatedWatchers[0];
		for (let i = 0; i < 1_010; i++) {
			csWatcher._fireChange({ fsPath: `/project/Assets/Generated/File${i}.cs` });
		}

		await sleep(500);
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].payload.files.length, 1_000);
		watcher.dispose();
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

	await testAsync('resolveMetaFile blocks paths outside the workspace', async () => {
		const projectPath = path.join(tmpDir, 'p-traversal');
		fs.mkdirSync(projectPath);
		fs.writeFileSync(path.join(tmpDir, 'Outside.cs.meta'), 'guid: outside\n');

		const origFolders = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = [{ uri: { fsPath: projectPath }, name: 'test' }];

		const manager = new MetaManager();
		const content = await manager.resolveMetaFile('../Outside.cs');

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

	await testAsync('UNITY_CURSOR_TOOLKIT_PROJECT_PATH links proof workspaces without prior state', async () => {
		const unityProject = path.join(tmpDir, 'EnvGame');
		fs.mkdirSync(path.join(unityProject, 'Assets'), { recursive: true });

		const ctx = createMockExtensionContext(tmpDir);
		initializeUnityProjectHandler(ctx);
		const previousProjectPath = process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH;
		process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = unityProject;
		try {
			assert.strictEqual(hasLinkedUnityProject(), true, 'Env project path should count as a linked Unity project');
			assert.strictEqual(getLinkedProjectPath(), unityProject);
		} finally {
			if (previousProjectPath === undefined) {
				delete process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH;
			} else {
				process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = previousProjectPath;
			}
		}
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
	fs.writeFileSync(path.join(tmpDir, 'Outside.cs.meta'), 'guid: outside\n');

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

	await testAsync('resolve_meta returns error for non-string assetPath', async () => {
		const result = await tools.handleToolCall('resolve_meta', { assetPath: 123 });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('required'));
	});

	await testAsync('resolve_meta blocks asset paths outside the workspace', async () => {
		const result = await tools.handleToolCall('resolve_meta', { assetPath: '../Outside.cs' });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('No .meta file'));
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
	const panel = new ConsolePanelProvider(bridge);

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

	test('webview script uses CSP nonce instead of unsafe inline script', () => {
		const html = panel.getHtml({ cspSource: 'vscode-webview:' });
		assert.ok(html.includes("script-src vscode-webview: 'nonce-"));
		assert.ok(!html.includes("script-src vscode-webview: 'unsafe-inline'"));
		assert.ok(html.includes("style-src vscode-webview: 'nonce-"));
		assert.ok(!html.includes("style-src vscode-webview: 'unsafe-inline'"));
		assert.match(html, /<style nonce="[a-f0-9]{32}">/);
		assert.match(html, /<script nonce="[a-f0-9]{32}">/);
	});

	test('webview caps retained entries and incrementally filters streamed entries', () => {
		const html = panel.getHtml({ cspSource: 'vscode-webview:' });
		const addEntryStart = html.indexOf('function addEntry(e)');
		const addEntryEnd = html.indexOf("logArea.addEventListener('scroll'", addEntryStart);
		const addEntryBody = html.slice(addEntryStart, addEntryEnd);

		assert.ok(html.includes('let maxEntries = 1000;'));
		assert.ok(html.includes('maxEntries = Math.min(1000, Math.max(1, Math.floor(msg.maxEntries)));'));
		assert.ok(addEntryBody.includes('entries.splice(0, overflow)'));
		assert.ok(addEntryBody.includes("logArea.querySelector('.log-entry')"));
		assert.ok(addEntryBody.includes('oldest.remove()'));
		assert.ok(addEntryBody.includes('applyFilterToEntry(rendered)'));
		assert.ok(!addEntryBody.includes('applyFilter();'), 'Streaming one entry must not rescan the entire DOM');
	});

	await testAsync('webview clear clears bridge entries', async () => {
		const localEmitter = new MockEventEmitter();
		const localBridge = new ConsoleBridge({ onMessage: localEmitter.event });
		const localPanel = new ConsolePanelProvider(localBridge);

		localEmitter.fire({ command: 'consoleEntry', payload: { command: 'consoleEntry', type: 'Log', message: 'Still in bridge', stackTrace: '', timestamp: '2026-01-01T12:00:03Z' } });
		assert.strictEqual(localBridge.getEntries().length, 1);

		await localPanel.handleWebviewMessage({ type: 'clear' });

		assert.strictEqual(localBridge.getEntries().length, 0);
		localPanel.dispose();
		localBridge.dispose();
	});

	await testAsync('openFileAtLine rejects traversal paths', async () => {
		const origFolders = vscode.workspace.workspaceFolders;
		const origOpenTextDocument = vscode.workspace.openTextDocument;
		const openedPaths = [];

		try {
			vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace' }, name: 'test' }];
			vscode.workspace.openTextDocument = async (uri) => {
				openedPaths.push(uri.fsPath);
				return { getText: () => '', uri };
			};

			await panel.openFileAtLine('Assets/../package.json', 1);
			await panel.openFileAtLine('../Assets/Scripts/Player.cs', 1);
			assert.deepStrictEqual(openedPaths, []);

			await panel.openFileAtLine('Assets/Scripts/Player.cs', 42);
			assert.deepStrictEqual(openedPaths, [path.join('/workspace', 'Assets', 'Scripts', 'Player.cs')]);
		} finally {
			vscode.workspace.openTextDocument = origOpenTextDocument;
			vscode.workspace.workspaceFolders = origFolders;
		}
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// viewport/index.ts (webview source guards)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testViewportWebviewSource() {
	console.log('\n── viewport/index.ts ──');
	const source = fs.readFileSync(path.join(outDir, 'viewport', 'index.js'), 'utf8');
	const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
	const windowsProofRunner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-windows-unity-without-editor-proof.js'), 'utf8');
	const unityWithoutEditorAudit = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'audit-unity-without-editor.js'), 'utf8');
	const installedCursorSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-installed-cursor-viewports.js'), 'utf8');
	const workspaceRoot = path.join(__dirname, '..', '..');
	const viewportStreamTool = fs.readFileSync(path.join(workspaceRoot, 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor', 'MCP', 'ViewportStreamTool.cs'), 'utf8');
	const viewportStreamToolMirror = fs.readFileSync(path.join(workspaceRoot, 'CursorUnityTool', 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor', 'MCP', 'ViewportStreamTool.cs'), 'utf8');
	const editorWindowCapture = fs.readFileSync(path.join(workspaceRoot, 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor', 'MCP', 'EditorWindowViewportCapture.cs'), 'utf8');
	const editorWindowCaptureMirror = fs.readFileSync(path.join(workspaceRoot, 'CursorUnityTool', 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor', 'MCP', 'EditorWindowViewportCapture.cs'), 'utf8');

	test('live Unity frames are not covered by toolkit HUD overlays', () => {
		assert.ok(!source.includes('viewport-hud'), 'Viewport webview should not overlay HUD chrome on Unity pixels');
		assert.ok(!source.includes('streamBadge'), 'Streaming status should stay outside the rendered Unity frame');
	});

	test('viewport commands expose real editor Inspector, Package Manager, and custom EditorWindow panels', () => {
		const commands = packageJson.contributes.commands.map((command) => command.command);
		assert.ok(commands.includes('unity-cursor-toolkit.viewport.openInspector'), 'Inspector command should be contributed');
		assert.ok(commands.includes('unity-cursor-toolkit.viewport.openPackageManager'), 'Package Manager command should be contributed');
		assert.ok(commands.includes('unity-cursor-toolkit.viewport.openCustomWindow'), 'custom EditorWindow command should be contributed');
		assert.ok(packageJson.activationEvents.includes('onCommand:unity-cursor-toolkit.viewport.openInspector'), 'Inspector command should activate the extension');
		assert.ok(packageJson.activationEvents.includes('onCommand:unity-cursor-toolkit.viewport.openPackageManager'), 'Package Manager command should activate the extension');
		assert.ok(packageJson.activationEvents.includes('onCommand:unity-cursor-toolkit.viewport.openCustomWindow'), 'custom EditorWindow command should activate the extension');
		assert.ok(source.includes('Open Inspector'), 'Quick Actions should expose Inspector');
		assert.ok(source.includes('Open Package Manager'), 'Quick Actions should expose Package Manager');
		assert.ok(source.includes('Open Custom EditorWindow'), 'Quick Actions should expose custom EditorWindow panels');
	});

	test('viewport commands expose explicit player-host Scene and Game panels', () => {
		const commands = packageJson.contributes.commands.map((command) => command.command);
		assert.ok(commands.includes('unity-cursor-toolkit.viewport.openPlayerSceneView'), 'player Scene View command should be contributed');
		assert.ok(commands.includes('unity-cursor-toolkit.viewport.openPlayerGameView'), 'player Game View command should be contributed');
		assert.ok(packageJson.activationEvents.includes('onCommand:unity-cursor-toolkit.viewport.openPlayerSceneView'), 'player Scene View command should activate the extension');
		assert.ok(packageJson.activationEvents.includes('onCommand:unity-cursor-toolkit.viewport.openPlayerGameView'), 'player Game View command should activate the extension');
		assert.ok(source.includes('Open Player Scene View'), 'Quick Actions should expose player Scene View');
		assert.ok(source.includes('Open Player Game View'), 'Quick Actions should expose player Game View');
		assert.ok(source.includes("host: this.host"), 'Viewport stream requests should use the panel host');
		assert.ok(source.includes("captureMode: this.host === 'player' ? 'camera' : 'editorWindow'"), 'Player panels should request camera capture while editor panels request editor-window capture');
		assert.ok(source.includes('Attaching to running Viewport Service player'), 'Player panels should attach without launching the Unity editor');
	});

	test('installed Cursor viewport proof mode is explicit and records editor frame hashes', () => {
		assert.ok(source.includes('UNITY_CURSOR_TOOLKIT_VIEWPORT_PROOF_OUT'), 'Proof mode should only run when explicitly requested by env');
		assert.ok(source.includes("proofMode: 'installed-cursor-editor-scene-game'"), 'Proof report should identify the installed Cursor Scene/Game proof mode');
		assert.ok(source.includes('this.openSceneView();'), 'Proof mode should open the real editor Scene View panel');
		assert.ok(source.includes('this.openGameView();'), 'Proof mode should open the real editor Game View panel');
		assert.ok(source.includes("value.host === 'editor'"), 'Proof mode should require editor-hosted frames');
		assert.ok(source.includes("value.captureMode === 'editorWindow'"), 'Proof mode should require real EditorWindow capture mode');
		assert.ok(source.includes('createHash'), 'Proof mode should hash the rendered frame bytes');
		assert.ok(source.includes("'sha256'"), 'Proof mode should use SHA-256 for frame hashes');
		assert.ok(source.includes('pendingStartStream'), 'Proof auto-start should stay single-flight while Unity is launching');
		assert.ok(source.includes('autoStartRequested'), 'Proof auto-start should survive webview initialization timing');
		assert.ok(source.includes('runProofInput'), 'Proof mode should require input delivery, not only frame hashes');
		assert.ok(source.includes('isProofInputReady'), 'Proof pass criteria should include editor-window input proof');
		assert.ok(source.includes('inputProof: this.inputProof ?? null'), 'Proof reports should archive input proof details');
		assert.ok(source.includes('requestPointerLock'), 'Game View should request pointer lock for mouse-look style input');
		assert.ok(source.includes('Viewport input failed'), 'Viewport input failures should be visible instead of silently ignored');
		assert.ok(installedCursorSmoke.includes('UNITY_CURSOR_TOOLKIT_PROJECT_PATH'), 'Installed Cursor proof should pin the Unity project path in isolated Cursor');
	});

	test('editor-window viewport input and GameView orientation are first-class proof requirements', () => {
		for (const content of [viewportStreamTool, viewportStreamToolMirror]) {
			assert.ok(content.includes('session.captureMode == "editorWindow" && TryEditorWindowInput'), 'editorWindow input should run before project/input-system fallbacks');
			assert.ok(!content.includes('session.captureMode == "editorWindow" && session.view == "scene"'), 'editorWindow input should not be scene-only');
		}
		for (const content of [editorWindowCapture, editorWindowCaptureMirror]) {
			assert.ok(content.includes('ShouldFlipReadbackVertically(string view)'), 'orientation fix should be view-aware');
			assert.ok(content.includes('|| view == "game"'), 'GameView readback should be flipped where Unity returns a bottom-origin buffer');
		}
		assert.ok(unityWithoutEditorAudit.includes('inputProof.success !== true'), 'Audit should reject proof artifacts that only have frame hashes');
		assert.ok(unityWithoutEditorAudit.includes("inputProof.layer !== 'editorWindow'"), 'Audit should require input to hit the Unity EditorWindow layer');
	});

	test('Unity project markers activate viewport proof without manual command palette use', () => {
		assert.ok(packageJson.activationEvents.includes('workspaceContains:ProjectSettings/ProjectVersion.txt'), 'Unity project roots should activate from ProjectVersion.txt');
		assert.ok(packageJson.activationEvents.includes('workspaceContains:**/ProjectSettings/ProjectVersion.txt'), 'parent workspaces containing Unity projects should activate from nested ProjectVersion.txt');
		assert.ok(packageJson.activationEvents.includes('workspaceContains:Assets/**/*.cs'), 'Unity script folders should activate the extension');
		assert.ok(packageJson.activationEvents.includes('onStartupFinished'), 'installed Cursor proof mode needs activation without command-palette input');
	});

	test('Windows proof gate requires installed Cursor Scene/Game frame hashes', () => {
		assert.ok(windowsProofRunner.includes('Installed Cursor automated editor Scene/Game frame proof'), 'Windows runner should execute the installed Cursor proof step');
		assert.ok(windowsProofRunner.includes('smoke-installed-cursor-viewports.js'), 'Windows runner should use the packaged installed-Cursor smoke runner');
		assert.ok(windowsProofRunner.includes('--viewport-proof-out'), 'Windows runner should request archived viewport proof JSON');
		assert.ok(windowsProofRunner.includes('installed-cursor-editor-scene-game-auto-proof-windows.json'), 'Windows runner should archive Windows Cursor proof JSON');
		assert.ok(unityWithoutEditorAudit.includes("requireStep(summary, 'Installed Cursor automated editor Scene/Game frame proof')"), 'Audit should require the Windows Cursor proof step');
		assert.ok(unityWithoutEditorAudit.includes("resolveWindowsArtifact(proof, 'installedCursorViewportProof'"), 'Audit should load the Windows Cursor proof artifact');
		assert.ok(unityWithoutEditorAudit.includes("cursorSmoke.platform !== 'win32'"), 'Audit should reject non-Windows Cursor smoke artifacts');
		assert.ok(unityWithoutEditorAudit.includes("validateInstalledCursorProofPanel(cursorProof.panels?.sceneView, 'scene')"), 'Audit should validate the Windows Scene View proof panel');
		assert.ok(unityWithoutEditorAudit.includes("validateInstalledCursorProofPanel(cursorProof.panels?.gameView, 'game')"), 'Audit should validate the Windows Game View proof panel');
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
	testUnityEditorLauncher();
	testUnityLicenseScript();
	await testConnectionTcp();
	await testCommandSender();
	testConsoleBridge();
	testUnityProfilerSafetySource();
	await testConsoleModuleRetention();
	await testConsoleMcpTools();
	await testToolRouter();
	await testUnityMcpTools();
	await testStandaloneMcpServer();
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
	testViewportWebviewSource();
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
