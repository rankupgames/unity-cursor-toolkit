/**
 * Focused tests for the Unity VDD remote shell MVP.
 * Run after compile: node test/remote-shell-tests.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const outDir = path.join(__dirname, '..', 'out');
const repoRoot = path.resolve(__dirname, '..', '..');
const fakeWorkspaceRoot = path.join(path.parse(process.cwd()).root, 'repo');
const fakeExtensionRoot = path.join(path.parse(process.cwd()).root, 'ext');
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

function createManifest(overrides = {}) {
	return {
		sshTarget: 'win-vdd',
		remoteWorkspacePath: 'C:\\remote_workspace\\game',
		unityPlayerPath: 'C:\\remote_workspace\\game\\Build\\Game.exe',
		windowTitle: 'Unity VDD Shell',
		vddMonitor: 3,
		display: { width: 1600, height: 900, fps: 24, quality: 80 },
		ports: { stream: 50100, control: 50101 },
		...overrides
	};
}

function writeManifest(tmpDir, manifest = createManifest()) {
	const manifestPath = path.join(tmpDir, 'unity-shell.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	return manifestPath;
}

function main() {
	console.log('Unity Cursor Toolkit -- Remote Shell Tests\n');
	console.log(`Using compiled output: ${outDir}`);

	const { parseRemoteShellManifest, resolveManifestPath, createExampleManifest } = require(path.join(outDir, 'remote-shell', 'manifest'));
	const { createRemoteShellPlan, buildRemoteStartCommand } = require(path.join(outDir, 'remote-shell', 'sidecarPlan'));
	const { buildRemoteShellInvocation, resolveRemoteShellManifestPath } = require(path.join(outDir, 'remote-shell', 'extensionCommands'));

	console.log('\n-- remote-shell/manifest.ts --');
	test('manifest parser applies defaults and validates required fields', () => {
		const parsed = parseRemoteShellManifest({
			sshTarget: 'win-vdd',
			remoteWorkspacePath: 'C:\\remote_workspace\\game',
			unityPlayerPath: 'C:\\remote_workspace\\game\\Game.exe'
		});
		assert.strictEqual(parsed.display.width, 1280);
		assert.strictEqual(parsed.display.height, 720);
		assert.strictEqual(parsed.display.fps, 30);
		assert.strictEqual(parsed.ports.stream, 48170);
		assert.strictEqual(parsed.ports.control, 48171);
		assert.strictEqual(parsed.vddMonitor, 2);
		assert.ok(parsed.remoteSidecarPath.endsWith('tools\\unity-vdd-shell\\unity-vdd-sidecar.ps1'));
		assert.throws(() => parseRemoteShellManifest({ sshTarget: 'x' }), /remoteWorkspacePath/);
		assert.throws(() => parseRemoteShellManifest(createManifest({ ports: { stream: 5000, control: 5000 } })), /different/);
	});

	test('resolveManifestPath supports workspace token and relative defaults', () => {
		assert.strictEqual(
			resolveManifestPath(fakeWorkspaceRoot, '${workspaceFolder}/remote_workspace/unity-shell.json'),
			path.join(fakeWorkspaceRoot, 'remote_workspace', 'unity-shell.json')
		);
		assert.strictEqual(
			resolveManifestPath(fakeWorkspaceRoot),
			path.join(fakeWorkspaceRoot, 'remote_workspace', 'unity-shell.json')
		);
		assert.strictEqual(createExampleManifest().sshTarget, 'unity-vdd-host');
	});

	console.log('\n-- remote-shell/sidecarPlan.ts --');
	test('sidecar plan constructs SSH tunnels, remote PowerShell start, and shell launch', () => {
		const manifest = parseRemoteShellManifest(createManifest());
		const plan = createRemoteShellPlan(manifest, {
			manifestPath: '/repo/remote_workspace/unity-shell.json',
			extensionRoot: '/repo/unity-cursor-toolkit',
			localPortBase: 61000,
			shellAppPath: '/Applications/UnityVddShell.app'
		});

		assert.deepStrictEqual(plan.sshTunnel.args, [
			'-N',
			'-L', '61000:127.0.0.1:50100',
			'-L', '61001:127.0.0.1:50101',
			'win-vdd'
		]);
		assert.strictEqual(plan.links.streamUrl, 'http://127.0.0.1:61000/viewport.mjpg');
		assert.strictEqual(plan.links.statusUrl, 'http://127.0.0.1:61001/status.json');
		assert.strictEqual(plan.shellLaunch.command, 'open');
		assert.ok(plan.remoteStart.args[1].includes('powershell.exe'));
		assert.ok(plan.remoteStart.args[1].includes('-UnityPlayerPath'));
		assert.ok(plan.remoteStart.args[1].includes('-WindowTitle'));
	});

	test('remote start command includes Unity display and FFmpeg capture inputs', () => {
		const command = buildRemoteStartCommand(parseRemoteShellManifest(createManifest()));
		assert.ok(command.includes('-Monitor 3'));
		assert.ok(command.includes('-Width 1600'));
		assert.ok(command.includes('-Height 900'));
		assert.ok(command.includes('-Fps 24'));
		assert.ok(command.includes('-Quality 80'));
		assert.ok(command.includes('-StreamPort 50100'));
		assert.ok(command.includes('-ControlPort 50101'));
	});

	console.log('\n-- remote-shell/sidecarCli.ts --');
	test('CLI plan prints a deterministic launch plan without opening SSH', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-remote-shell-'));
		const manifestPath = writeManifest(tmpDir);
		try {
			const result = spawnSync(process.execPath, [
				path.join(outDir, 'remote-shell', 'sidecarCli.js'),
				'plan',
				'--manifest', manifestPath,
				'--workspace-root', tmpDir,
				'--extension-root', path.join(repoRoot, 'unity-cursor-toolkit'),
				'--local-port-base', '62000'
			], { encoding: 'utf8' });
			assert.strictEqual(result.status, 0, result.stderr);
			const plan = JSON.parse(result.stdout);
			assert.strictEqual(plan.links.streamUrl, 'http://127.0.0.1:62000/viewport.mjpg');
			assert.strictEqual(plan.links.controlUrl, 'http://127.0.0.1:62001');
			assert.strictEqual(plan.sshTunnel.command, 'ssh');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	console.log('\n-- remote-shell/extensionCommands.ts --');
	test('extension invocation resolves workspace manifest and sidecar command', () => {
		const invocation = buildRemoteShellInvocation('launch', fakeExtensionRoot, fakeWorkspaceRoot, {
			manifestPath: '${workspaceFolder}/remote_workspace/unity-shell.json',
			shellAppPath: '${workspaceFolder}/unity-cursor-toolkit/native-shell/UnityVddShell/.build/release/UnityVddShell',
			localPortBase: 63000
		});
		assert.strictEqual(invocation.command, process.execPath);
		assert.ok(invocation.args.includes(path.join(fakeExtensionRoot, 'out', 'remote-shell', 'sidecarCli.js')));
		assert.ok(invocation.args.includes(path.join(fakeWorkspaceRoot, 'remote_workspace', 'unity-shell.json')));
		assert.ok(invocation.args.includes('--shell-app'));
		assert.ok(invocation.args.includes('63000'));
		assert.strictEqual(resolveRemoteShellManifestPath({}, fakeWorkspaceRoot), path.join(fakeWorkspaceRoot, 'remote_workspace', 'unity-shell.json'));
	});

	console.log('\n-- remote-shell assets --');
	test('Windows sidecar script exposes Unity player launch, gdigrab capture, status, input, and stop routes', () => {
		const script = fs.readFileSync(path.join(repoRoot, 'unity-cursor-toolkit', 'remote-shell', 'windows', 'unity-vdd-sidecar.ps1'), 'utf8');
		assert.ok(script.includes('-monitor'));
		assert.ok(script.includes('gdigrab'));
		assert.ok(script.includes('viewport.mjpg'));
		assert.ok(script.includes('/status.json'));
		assert.ok(script.includes('/input'));
		assert.ok(script.includes('/stop'));
	});

	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failures.length > 0) {
		console.log('\nFailures:');
		for (const failure of failures) {
			console.log(`  - ${failure.name}`);
			console.log(`    ${failure.err.message}`);
		}
	}
	console.log(`${'='.repeat(60)}`);
	process.exit(failed > 0 ? 1 : 0);
}

main();
