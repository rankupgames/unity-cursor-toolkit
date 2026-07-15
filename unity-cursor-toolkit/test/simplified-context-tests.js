/**
 * Focused tests for the simplified Unity context engine MCP surfaces.
 * Run after compile: node test/simplified-context-tests.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const outDir = path.join(__dirname, '..', 'out');
let passed = 0;
let failed = 0;
const failures = [];

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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseToolJson(result) {
	return JSON.parse(result.content[0].text);
}

function withEnv(updates, fn) {
	const previous = {};
	for (const key of Object.keys(updates)) {
		previous[key] = process.env[key];
		if (updates[key] == null) {
			delete process.env[key];
		} else {
			process.env[key] = updates[key];
		}
	}

	const restore = () => {
		for (const key of Object.keys(updates)) {
			if (previous[key] == null) {
				delete process.env[key];
			} else {
				process.env[key] = previous[key];
			}
		}
	};

	try {
		const result = fn();
		if (result && typeof result.then === 'function') {
			return result.finally(restore);
		}
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
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

async function getUnusedPort() {
	const server = net.createServer();
	const port = await listenOnLocalhost(server);
	await closeServer(server);
	return port;
}

function httpGet(url) {
	return new Promise((resolve, reject) => {
		http.get(url, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => {
				resolve({
					statusCode: response.statusCode,
					headers: response.headers,
					body: Buffer.concat(chunks)
				});
			});
		}).on('error', reject);
	});
}

function startMcpServer(env = {}) {
	const child = spawn(process.execPath, [path.join(outDir, 'mcp', 'server.js')], {
		env: { ...process.env, ...env },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const pending = new Map();
	let stdoutBuffer = '';
	let stderr = '';
	let requestId = 0;

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

	return {
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

function createUnityContextFixture(prefix = 'uct-context-') {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const projectRoot = path.join(tmpDir, 'UnityProject');
	const assetsRoot = path.join(projectRoot, 'Assets');

	fs.mkdirSync(path.join(assetsRoot, 'Scenes'), { recursive: true });
	fs.mkdirSync(path.join(assetsRoot, 'Scripts'), { recursive: true });
	fs.mkdirSync(path.join(assetsRoot, 'Prefabs'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, 'Packages'), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, 'ProjectSettings'), { recursive: true });

	const scriptGuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	const prefabGuid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	const sceneGuid = 'cccccccccccccccccccccccccccccccc';

	fs.writeFileSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.9f1\n');
	fs.writeFileSync(path.join(projectRoot, 'Packages', 'manifest.json'), '{"dependencies":{"com.unity.inputsystem":"1.11.2"}}\n');
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Scripts', 'PlayerController.cs'), 'public sealed class PlayerController {}\n');
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Scripts', 'PlayerController.cs.meta'), `fileFormatVersion: 2\nguid: ${scriptGuid}\n`);
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Prefabs', 'Enemy.prefab'), '%YAML 1.1\n--- !u!1 &300000\nGameObject:\n  m_Name: EnemyPrefab\n');
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Prefabs', 'Enemy.prefab.meta'), `fileFormatVersion: 2\nguid: ${prefabGuid}\n`);
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Scenes', 'Sample.unity'), `%YAML 1.1
--- !u!1 &100000
GameObject:
  m_Name: Player
  m_Component:
  - component: {fileID: 400000}
  - component: {fileID: 11400000}
--- !u!4 &400000
Transform:
  m_GameObject: {fileID: 100000}
--- !u!114 &11400000
MonoBehaviour:
  m_GameObject: {fileID: 100000}
  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}
  enemyPrefab: {fileID: 300000, guid: ${prefabGuid}, type: 3}
`);
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'Scenes', 'Sample.unity.meta'), `fileFormatVersion: 2\nguid: ${sceneGuid}\n`);
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'binary.asset'), Buffer.from([0, 1, 2, 3]));
	fs.writeFileSync(path.join(projectRoot, 'Assets', 'binary.asset.meta'), 'fileFormatVersion: 2\nguid: dddddddddddddddddddddddddddddddd\n');
	fs.writeFileSync(path.join(tmpDir, 'Outside.cs.meta'), 'fileFormatVersion: 2\nguid: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n');

	return { tmpDir, projectRoot, scriptGuid, prefabGuid, sceneGuid };
}

function testToolMetadata() {
	console.log('\n-- mcp/toolMetadata.ts --');
	const { isMutatingToolCall } = require(path.join(outDir, 'mcp', 'toolMetadata'));

	test('unity_context action mutability matches scan/query/read/summary contract', () => {
		assert.strictEqual(isMutatingToolCall('unity_context', { action: 'scan' }), true);
		assert.strictEqual(isMutatingToolCall('unity_context', { action: 'query' }), false);
		assert.strictEqual(isMutatingToolCall('unity_context', { action: 'read' }), false);
		assert.strictEqual(isMutatingToolCall('unity_context', { action: 'summary' }), false);
	});

	test('viewport_stream status is read-only while stream and input actions mutate host state', () => {
		assert.strictEqual(isMutatingToolCall('viewport_stream', { action: 'status' }), false);
		assert.strictEqual(isMutatingToolCall('viewport_stream', { action: 'start' }), true);
		assert.strictEqual(isMutatingToolCall('viewport_stream', { action: 'stop' }), true);
		assert.strictEqual(isMutatingToolCall('viewport_stream', { action: 'input' }), true);
	});
}

async function testGameCommandBatchmode() {
	console.log('\n-- mcp/gameCommandBatchmode.ts --');
	const { UnityMcpTools } = require(path.join(outDir, 'mcp', 'unityMcpTools'));
	const fixture = createUnityContextFixture('uct-batchmode-');
	let requestCount = 0;

	try {
		await withEnv({ UNITY_CURSOR_TOOLKIT_PROJECT_PATH: fixture.projectRoot }, async () => {
			const tools = new UnityMcpTools({
				send() {},
				request: async () => {
					requestCount++;
					return { result: 'should-not-run', error: false };
				}
			});

			await testAsync('game_command host=editorBatchmode dryRun builds Unity batchmode command without sending to Unity', async () => {
				const result = await tools.handleToolCall('game_command', {
					action: 'run',
					host: 'editorBatchmode',
					commandName: 'smoke.ping',
					args: { value: 42 },
					unityPath: '/tmp/FakeUnity',
					dryRun: true
				});
				const payload = parseToolJson(result);

				assert.strictEqual(requestCount, 0);
				assert.strictEqual(payload.host, 'editorBatchmode');
				assert.strictEqual(payload.batchmode.unityPath, '/tmp/FakeUnity');
				assert.strictEqual(payload.batchmode.projectPath, fixture.projectRoot);
				assert.ok(payload.batchmode.command.includes('-batchmode'));
				assert.ok(payload.batchmode.command.includes('-executeMethod'));
				assert.ok(payload.batchmode.command.includes('UnityCursorToolkit.AgentCommands.BatchCommandEntry.Run'));
				assert.ok(payload.batchmode.command.includes('-uctCommandName'));
				assert.ok(payload.batchmode.command.includes('smoke.ping'));
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(payload.batchmode.argsPath, 'utf8')), { value: 42 });
				fs.rmSync(path.dirname(payload.batchmode.resultPath), { recursive: true, force: true });
			});
		});
	} finally {
		fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
	}
}

async function testUnityContextMcpTools() {
	console.log('\n-- mcp/unityContextIndex.ts --');
	const { UnityContextMcpTools, scanUnityProject } = require(path.join(outDir, 'mcp', 'unityContextIndex'));
	const fixture = createUnityContextFixture();

	try {
		await testAsync('scanUnityProject extracts meta GUIDs, UnityYAML objects, components, and dependency edges', async () => {
			const index = await scanUnityProject(fixture.projectRoot);

			assert.ok(index.roots.includes('Assets'));
			assert.ok(index.roots.includes('Packages'));
			assert.ok(index.roots.includes('ProjectSettings'));
			assert.ok(index.stats.metaGuids >= 4);
			assert.ok(index.stats.objects >= 2);
			assert.ok(index.stats.components >= 2);
			assert.ok(index.nodes.some((node) => node.kind === 'object' && node.name === 'Player'));
			assert.ok(index.nodes.some((node) => node.kind === 'component' && node.scriptGuid === fixture.scriptGuid));
			assert.ok(index.edges.some((edge) => edge.type === 'references' && edge.guid === fixture.scriptGuid && edge.to === 'asset:Assets/Scripts/PlayerController.cs'));
			assert.ok(index.edges.some((edge) => edge.type === 'references' && edge.guid === fixture.prefabGuid && edge.to === 'asset:Assets/Prefabs/Enemy.prefab'));
			assert.ok(index.nodes.some((node) => node.path === 'Assets/binary.asset' && node.guid === 'dddddddddddddddddddddddddddddddd'));
			assert.ok(!index.nodes.some((node) => node.guid === 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), 'scanner must not traverse outside Unity project scan roots');
		});

		await testAsync('unity_context scan dryRun does not write, then scan writes .umetacontext/index.json', async () => {
			const tools = new UnityContextMcpTools(fixture.projectRoot);
			const indexPath = path.join(fixture.projectRoot, '.umetacontext', 'index.json');

			fs.rmSync(path.dirname(indexPath), { recursive: true, force: true });
			const dryRun = parseToolJson(await tools.handleToolCall('unity_context', { action: 'scan', dryRun: true }));
			assert.strictEqual(dryRun.dryRun, true);
			assert.strictEqual(dryRun.wouldWrite, indexPath);
			assert.strictEqual(fs.existsSync(indexPath), false);

			const scan = parseToolJson(await tools.handleToolCall('unity_context', { action: 'scan' }));
			assert.strictEqual(scan.success, true);
			assert.strictEqual(scan.path, indexPath);
			assert.strictEqual(fs.existsSync(indexPath), true);
		});

		await testAsync('unity_context query/read/summary return compact indexed context', async () => {
			const tools = new UnityContextMcpTools(fixture.projectRoot);
			await tools.handleToolCall('unity_context', { action: 'scan' });

			const query = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', query: 'Player', limit: 10 }));
			assert.strictEqual(query.success, true);
			assert.ok(query.nodes.some((node) => node.name === 'Player'));

			const byClass = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', query: '114', limit: 10 }));
			assert.ok(byClass.nodes.some((node) => node.type === 'MonoBehaviour'));

			const byType = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', type: 'MonoBehaviour', limit: 10 }));
			assert.ok(byType.nodes.every((node) => node.type === 'MonoBehaviour'));

			const byScene = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', scenePath: 'Assets/Scenes/Sample.unity', limit: 10 }));
			assert.ok(byScene.nodes.some((node) => node.name === 'Player'));

			const byPrefab = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', prefabPath: 'Assets/Prefabs/Enemy.prefab', limit: 10 }));
			assert.ok(byPrefab.nodes.some((node) => node.name === 'EnemyPrefab'));

			const byDependency = parseToolJson(await tools.handleToolCall('unity_context', { action: 'query', dependency: 'Assets/Prefabs/Enemy.prefab', limit: 10 }));
			assert.ok(byDependency.nodes.some((node) => node.type === 'MonoBehaviour' && node.assetPath === 'Assets/Scenes/Sample.unity'));

			const read = parseToolJson(await tools.handleToolCall('unity_context', { action: 'read', name: 'Player' }));
			assert.strictEqual(read.success, true);
			assert.strictEqual(read.node.name, 'Player');
			assert.ok(read.edges.some((edge) => edge.type === 'contains'));
			assert.ok(read.adjacent.some((node) => node.type === 'MonoBehaviour' || node.type === 'Transform'));

			const summary = parseToolJson(await tools.handleToolCall('unity_context', { action: 'summary', limit: 5 }));
			assert.strictEqual(summary.success, true);
			assert.ok(summary.scenes.some((node) => node.path === 'Assets/Scenes/Sample.unity'));
			assert.ok(summary.scripts.some((node) => node.path === 'Assets/Scripts/PlayerController.cs'));
			assert.ok(summary.namedObjects.some((node) => node.name === 'Player'));
		});
	} finally {
		fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
	}
}

async function testViewportStreamMcpTools() {
	console.log('\n-- mcp/viewportStreamTools.ts --');
	const { ViewportStreamMcpTools, buildViewportHostSessionSnapshot } = require(path.join(outDir, 'mcp', 'viewportStreamTools'));

	await testAsync('viewport_stream start/status/frame/stop uses local MJPEG server and Unity frame messages', async () => {
		const calls = [];
		const tools = new ViewportStreamMcpTools({
			send() {},
			request: async (cmd, payload) => {
				calls.push({ cmd, payload });
				return { result: { success: true, echo: payload.args } };
			}
		});

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-viewport-'));
		try {
			const start = parseToolJson(await tools.handleToolCall('viewport_stream', {
				action: 'start',
				width: 12,
				height: 8,
				fps: 5,
				quality: 55
			}));

			assert.strictEqual(start.success, true);
			assert.strictEqual(start.status.running, true);
			assert.strictEqual(start.status.width, 12);
			assert.strictEqual(start.status.height, 8);
			assert.ok(start.status.streamUrl.includes('/viewport.mjpg'));
			assert.strictEqual(start.status.hostSession.surface.kind, 'unityEditor');
			assert.strictEqual(start.status.hostSession.render.kind, 'editorWindow');
			assert.strictEqual(start.status.hostSession.compute.kind, 'localEditor');
			assert.strictEqual(start.status.hostSession.compute.supportsOffload, false);
			assert.strictEqual(start.status.hostSession.input.kind, 'unityMcp');
			assert.strictEqual(calls[0].payload.toolName, 'viewport_stream');
			assert.strictEqual(calls[0].payload.args.action, 'start');
			assert.strictEqual(calls[0].payload.args.captureMode, 'editorWindow');

			const framePath = path.join(tmpDir, 'frame.jpg');
			const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
			fs.writeFileSync(framePath, jpeg);
			tools.handleUnityMessage({
				command: 'viewportFrame',
				payload: {
					sessionId: start.status.sessionId,
					path: framePath,
					sequence: 7,
					width: 12,
					height: 8,
					timestamp: '2026-01-01T00:00:00Z'
				}
			});
			await sleep(30);

			const latest = await httpGet(start.status.streamUrl.replace('/viewport.mjpg', '/latest.jpg'));
			assert.strictEqual(latest.statusCode, 200);
			assert.strictEqual(latest.headers['content-type'], 'image/jpeg');
			assert.deepStrictEqual([...latest.body], [...jpeg]);

			const inBandJpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
			tools.handleUnityMessage({
				command: 'viewportFrame',
				payload: {
					sessionId: start.status.sessionId,
					data: inBandJpeg.toString('base64'),
					sequence: 8,
					width: 12,
					height: 8,
					timestamp: '2026-01-01T00:00:01Z'
				}
			});
			await sleep(30);

			const latestInBand = await httpGet(start.status.streamUrl.replace('/viewport.mjpg', '/latest.jpg'));
			assert.strictEqual(latestInBand.statusCode, 200);
			assert.deepStrictEqual([...latestInBand.body], [...inBandJpeg]);

			const status = parseToolJson(await tools.handleToolCall('viewport_stream', { action: 'status' }));
			assert.strictEqual(status.status.lastFrame.sequence, 8);

			const input = parseToolJson(await tools.handleToolCall('viewport_stream', {
				action: 'input',
				inputType: 'tap',
				x: 3,
				y: 4
			}));
			assert.strictEqual(input.success, true);
			assert.strictEqual(calls[calls.length - 1].payload.args.inputType, 'tap');
			assert.strictEqual(calls[calls.length - 1].payload.args.sessionId, start.status.sessionId);

			const stop = parseToolJson(await tools.handleToolCall('viewport_stream', { action: 'stop' }));
			assert.strictEqual(stop.success, true);
			assert.strictEqual(stop.stopped.running, true);
		} finally {
			await tools.dispose();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	await testAsync('viewport_stream dryRun returns planned Unity commands without contacting Unity', async () => {
		let requestCount = 0;
		const tools = new ViewportStreamMcpTools({
			send() {},
			request: async () => {
				requestCount++;
				return { result: { success: true } };
			}
		});

		const start = parseToolJson(await tools.handleToolCall('viewport_stream', { action: 'start', dryRun: true, port: 8123 }));
		const input = parseToolJson(await tools.handleToolCall('viewport_stream', { action: 'input', inputType: 'key', key: 'Space', dryRun: true }));

		assert.strictEqual(requestCount, 0);
		assert.strictEqual(start.dryRun, true);
		assert.strictEqual(start.localServer.port, 8123);
		assert.strictEqual(start.hostSession.surface.kind, 'unityEditor');
		assert.strictEqual(start.hostSession.render.kind, 'editorWindow');
		assert.strictEqual(start.hostSession.input.kind, 'unityMcp');
		assert.strictEqual(input.args.inputType, 'key');
		assert.strictEqual(input.args.key, 'Space');
		await tools.dispose();
	});

	await testAsync('viewport host session selects player camera backend independently from Unity MCP input routing', async () => {
		const session = buildViewportHostSessionSnapshot({
			sessionId: 'viewport-player-test',
			host: 'player',
			view: 'game',
			captureMode: 'camera',
			width: 320,
			height: 180,
			fps: 12,
			quality: 60,
			streamUrl: 'http://127.0.0.1:8123/viewport.mjpg'
		});

		assert.strictEqual(session.surface.kind, 'unityEditor');
		assert.strictEqual(session.render.kind, 'playerCamera');
		assert.strictEqual(session.compute.kind, 'localEditor');
		assert.strictEqual(session.input.kind, 'unityMcp');
		assert.strictEqual(session.remote.kind, 'remoteUnityPlayer');
	});
}

async function testStandaloneReadOnlyContext() {
	console.log('\n-- mcp/server.ts unity_context read-only --');
	const fixture = createUnityContextFixture('uct-stdio-context-');
	const { UnityContextMcpTools } = require(path.join(outDir, 'mcp', 'unityContextIndex'));
	const closedPort = await getUnusedPort();
	const server = startMcpServer({
		UNITY_CURSOR_TOOLKIT_PROJECT_PATH: fixture.projectRoot,
		UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(closedPort),
		UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: '1'
	});

	try {
		await new UnityContextMcpTools(fixture.projectRoot).handleToolCall('unity_context', { action: 'scan' });
		await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

		await testAsync('read-only MCP mode blocks scan but allows dryRun/query/summary', async () => {
			const blocked = await server.request('tools/call', {
				name: 'unity_context',
				arguments: { action: 'scan' }
			});
			assert.strictEqual(blocked.result.isError, true);
			assert.ok(blocked.result.content[0].text.includes('blocked'));

			const dryRun = await server.request('tools/call', {
				name: 'unity_context',
				arguments: { action: 'scan', dryRun: true }
			});
			const dryRunPayload = JSON.parse(dryRun.result.content[0].text);
			assert.strictEqual(dryRunPayload.dryRun, true);

			const query = await server.request('tools/call', {
				name: 'unity_context',
				arguments: { action: 'query', query: 'Player' }
			});
			const queryPayload = JSON.parse(query.result.content[0].text);
			assert.strictEqual(queryPayload.success, true);
			assert.ok(queryPayload.nodes.some((node) => node.name === 'Player'));

			const summary = await server.request('tools/call', {
				name: 'unity_context',
				arguments: { action: 'summary', limit: 5 }
			});
			const summaryPayload = JSON.parse(summary.result.content[0].text);
			assert.strictEqual(summaryPayload.success, true);
			assert.ok(summaryPayload.scenes.some((node) => node.path === 'Assets/Scenes/Sample.unity'));
		});
	} finally {
		server.stop();
		fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
	}
}

async function main() {
	console.log('Unity Cursor Toolkit -- Simplified Context Tests\n');
	console.log(`Using compiled output: ${outDir}`);

	if (!fs.existsSync(outDir)) {
		console.error(`ERROR: ${outDir} does not exist. Run "npm run compile" first.`);
		process.exit(1);
	}

	testToolMetadata();
	await testGameCommandBatchmode();
	await testUnityContextMcpTools();
	await testViewportStreamMcpTools();
	await testStandaloneReadOnlyContext();

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
