#!/usr/bin/env node
/**
 * Runs real smoke tests against the bundled CursorUnityTool project:
 * - unity_context scan/query/read/summary against the project files.
 * - Unity batchmode play-mode smoke for game_command and viewport_stream.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const projectRoot = path.join(repoRoot, 'CursorUnityTool');
const contextDir = path.join(projectRoot, '.umetacontext');
const unityResultPath = '/tmp/uct-internal-smoke-result.json';
const unityLogPath = '/tmp/uct-internal-smoke.log';
const viewportFramePath = '/tmp/uct-internal-smoke-viewport.jpg';
const keepContext = process.argv.includes('--keep-context');

async function main() {
	console.log('Unity Cursor Toolkit -- Internal Unity Smoke\n');
	console.log(`Unity project: ${projectRoot}`);

	await runUnityContextSmoke();
	await runUnityBatchmodeSmoke();

	console.log('\nInternal Unity smoke passed.');
}

async function runUnityContextSmoke() {
	console.log('\n-- unity_context real project scan --');
	const { UnityContextMcpTools } = require(path.join(extensionRoot, 'out', 'mcp', 'unityContextIndex'));
	const tools = new UnityContextMcpTools(projectRoot);

	try {
		const scan = parseToolResult(await tools.handleToolCall('unity_context', { action: 'scan' }));
		assert(scan.success === true, `unity_context scan failed: ${JSON.stringify(scan)}`);
		assert(scan.stats.assets > 0, 'unity_context scan returned no assets');
		assert(scan.stats.metaGuids > 0, 'unity_context scan returned no meta GUIDs');
		assert(fs.existsSync(path.join(contextDir, 'index.json')), 'unity_context did not write .umetacontext/index.json');

		const summary = parseToolResult(await tools.handleToolCall('unity_context', { action: 'summary', limit: 8 }));
		assert(summary.success === true, `unity_context summary failed: ${JSON.stringify(summary)}`);
		assert(summary.scenes.length > 0, 'unity_context summary returned no scenes');
		assert(summary.scripts.length > 0, 'unity_context summary returned no scripts');

		const query = parseToolResult(await tools.handleToolCall('unity_context', { action: 'query', query: 'HotReloadHandler', limit: 5 }));
		assert(query.success === true && query.count > 0, `unity_context query failed: ${JSON.stringify(query)}`);

		const read = parseToolResult(await tools.handleToolCall('unity_context', { action: 'read', path: 'Assets/Scenes/SampleScene.unity' }));
		assert(read.success === true, `unity_context read failed: ${JSON.stringify(read)}`);

		console.log(`scan stats: ${JSON.stringify(scan.stats)}`);
		console.log(`summary: scenes=${summary.scenes.length}, scripts=${summary.scripts.length}, packages=${summary.packages.length}, namedObjects=${summary.namedObjects.length}`);
		console.log(`query HotReloadHandler: ${query.count} match(es)`);
	} finally {
		if (keepContext === false) {
			fs.rmSync(contextDir, { recursive: true, force: true });
			console.log('removed generated CursorUnityTool/.umetacontext');
		}
	}
}

async function runUnityBatchmodeSmoke() {
	console.log('\n-- Unity batchmode game_command + viewport_stream smoke --');
	const unityPath = resolveUnityPath();
	fs.rmSync(unityResultPath, { force: true });
	fs.rmSync(unityLogPath, { force: true });
	fs.rmSync(viewportFramePath, { force: true });

	const args = [
		'-batchmode',
		'-projectPath', projectRoot,
		'-executeMethod', 'UnityCursorToolkit.InternalSmoke.UnityCursorToolkitInternalSmoke.Run',
		'-uctSmokeResultPath', unityResultPath,
		'-uctSmokeViewportFramePath', viewportFramePath,
		'-logFile', unityLogPath
	];

	console.log(`Unity: ${unityPath}`);
	await runProcess(unityPath, args);

	const result = JSON.parse(fs.readFileSync(unityResultPath, 'utf8'));
	if (result.success !== true) {
		throw new Error(`Unity internal smoke failed: ${JSON.stringify(result)}\n${tail(unityLogPath, 120)}`);
	}

	assert(fs.existsSync(viewportFramePath), `Unity internal smoke did not persist viewport frame: ${viewportFramePath}`);
	const viewportFrameBytes = fs.statSync(viewportFramePath).size;
	assert(viewportFrameBytes > 0, `Unity internal smoke persisted an empty viewport frame: ${viewportFramePath}`);

	console.log(`Unity result: ${JSON.stringify(result)}`);
	console.log(`viewport frame: ${viewportFramePath} (${viewportFrameBytes} bytes)`);
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

function runProcess(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} exited with code=${code} signal=${signal}\n${tail(unityLogPath, 120)}`));
			}
		});
	});
}

function parseToolResult(result) {
	return JSON.parse(result.content[0].text);
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
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
