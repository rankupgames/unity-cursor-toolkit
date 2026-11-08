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
	const {
		createHttpInputRouter,
		createIdeShellSurface,
		createRemoteComputeBackend,
		createRemoteSidecarRenderBackend,
		createUnityHostSession,
		withSessionLifecycle
	} = require(path.join(outDir, 'remote-shell', 'session'));

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
		assert.strictEqual(parsed.remoteRepoPath, '');
		assert.strictEqual(parsed.unityEditorPath, '');
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
		assert.ok(createExampleManifest().remoteRepoPath.endsWith('unity-cursor-toolkit'));
		assert.ok(createExampleManifest().unityEditorPath.endsWith('Unity.exe'));
	});

	console.log('\n-- remote-shell/sidecarPlan.ts --');
	test('UnityHostSession composes shell surface, render backend, compute backend, and input router', () => {
		const session = createUnityHostSession({
			sessionId: 'session-test',
			local: { kind: 'localIde', label: 'Cursor shell' },
			remote: { kind: 'remoteMachine', label: 'win-vdd', workspacePath: 'C:\\remote_workspace\\game' },
			surface: createIdeShellSurface('Unity VDD Shell', { streamUrl: 'http://127.0.0.1:61000/viewport.mjpg' }),
			render: createRemoteSidecarRenderBackend({ width: 1280, height: 720, fps: 30, quality: 70, streamUrl: 'http://127.0.0.1:61000/viewport.mjpg' }),
			compute: createRemoteComputeBackend({ sshTarget: 'win-vdd', workspacePath: 'C:\\remote_workspace\\game', repoPath: 'C:\\remote_workspace\\repo' }),
			input: createHttpInputRouter('http://127.0.0.1:61001')
		}).snapshot();
		const running = withSessionLifecycle(session, 'running', '2026-06-18T00:00:00.000Z');

		assert.strictEqual(session.protocolVersion, 1);
		assert.strictEqual(session.surface.kind, 'ide');
		assert.strictEqual(session.render.kind, 'remoteSidecar');
		assert.strictEqual(session.compute.kind, 'remoteMachine');
		assert.strictEqual(session.compute.supportsOffload, true);
		assert.strictEqual(session.input.kind, 'remoteHttp');
		assert.strictEqual(running.lifecycle, 'running');
		assert.strictEqual(running.updatedAt, '2026-06-18T00:00:00.000Z');
	});

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
		assert.strictEqual(plan.session.surface.kind, 'ide');
		assert.strictEqual(plan.session.render.kind, 'remoteSidecar');
		assert.strictEqual(plan.session.compute.kind, 'remoteMachine');
		assert.strictEqual(plan.session.compute.sshTarget, 'win-vdd');
		assert.strictEqual(plan.session.compute.supportsOffload, true);
		assert.strictEqual(plan.session.input.kind, 'remoteHttp');
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
			assert.strictEqual(plan.session.surface.kind, 'ide');
			assert.strictEqual(plan.session.render.kind, 'remoteSidecar');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});


	console.log('\n-- read-only remote-shell doctor --');
	function invokeDoctor(tmpDir, replies = [], extraArgs = [], action = 'doctor') {
		const runner = [
			"const cp=require('child_process'),assert=require('assert');",
			"const replies=" + JSON.stringify(replies) + ";let stdout='',stderr='',calls=[];",
			"cp.spawn=()=>{throw new Error('Unexpected launch from doctor');};",
			"cp.execFile=(command,args,options,callback)=>{assert.strictEqual(command,'ssh');",
			"assert.strictEqual(options.windowsHide,true);assert.strictEqual(options.timeout,10000);assert.strictEqual(options.maxBuffer,65536);",
			"assert(args.includes('BatchMode=yes'));assert(args.includes('StrictHostKeyChecking=yes'));assert(args.includes('ConnectTimeout=5'));",
			"for(const option of ['UpdateHostKeys=no','CheckHostIP=no','PermitLocalCommand=no','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no','Tunnel=no','ControlMaster=no','ControlPath=none','ControlPersist=no','ForkAfterAuthentication=no']){assert(args.includes(option),'Doctor must disable '+option);}",
			"const encoded=args[args.length-1].split(' ').pop();const script=Buffer.from(encoded,'base64').toString('utf16le');",
			"calls.push(script.includes('-VersionOnly')?'sidecarversion':script.includes('Test-Path')?'remotepaths':'ssh');",
			"assert(!/Start-Process|New-Item|license status|license activate|license return|auth logout/.test(script));",
			"const reply=replies.shift();assert(reply,'Unexpected transport call');",
			"process.nextTick(()=>callback(reply.error?Object.assign(new Error('private transport details'),reply.error):null,",
			"reply.stdout===undefined?JSON.stringify(reply.data):reply.stdout,reply.stderr||''));};",
			"const {runCli}=require(" + JSON.stringify(path.join(outDir, 'remote-shell', 'sidecarCli.js')) + ");",
			"runCli(process.argv.slice(1),{stdout:{write:x=>{stdout+=x;}},stderr:{write:x=>{stderr+=x;}}})",
			".then(code=>process.stdout.write(JSON.stringify({code,stdout,stderr,calls}))).catch(e=>{console.error(e);process.exitCode=1;});"
		].join('');
		const args = [action, '--manifest', path.join(tmpDir, 'unity-shell.json'), '--workspace-root', tmpDir];
		for (const [flag, value] of [['--extension-root', path.join(repoRoot, 'unity-cursor-toolkit')], ['--shell-app', process.execPath], ['--format', 'json']]) {
			if (!extraArgs.includes(flag)) { args.push(flag, value); }
		}
		const result = spawnSync(process.execPath, ['-e', runner, ...args, ...extraArgs], { encoding: 'utf8', timeout: 10_000 });
		assert.strictEqual(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	}
	const reachableReply = { data: { reachable: true, host: 'private-host', key: 'PRIVATE_KEY' } };
	const pathsReply = { data: { workspace: true, player: true, sidecar: true, ffmpeg: true } };
	const versionReply = { data: { sidecarVersion: '1.0.0', user: 'private-user' } };
	function assertDoctorReport(response) {
		assert.strictEqual(response.code, 1, 'license health is unproved, so the doctor must not report overall success');
		assert.strictEqual(response.stderr, '');
		const report = JSON.parse(response.stdout);
		assert.deepStrictEqual(report.checks.map(check => check.id), ['manifest', 'localpaths', 'ssh', 'remotepaths', 'sidecarversion', 'license']);
		assert.strictEqual(report.success, false);
		for (const check of report.checks) {
			assert(['pass', 'fail'].includes(check.state));
			assert.match(check.code, /^[a-z_]+$/);
			assert.strictEqual(typeof check.message, 'string');
			assert.ok(check.remediation.length > 0);
		}
		assert.strictEqual(report.licenseState, 'unknown');
		assert.strictEqual(report.checks[5].code, 'license_probe_unavailable');
		return report;
	}
	test('doctor reports five passed checks while refusing an unproved license, without leaking private transport fields', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			const extensionRoot = path.join(tmpDir, 'installed-extension');
			fs.mkdirSync(extensionRoot);
			writeManifest(tmpDir, createManifest({ sshTarget: 'private-user@private-host', windowTitle: 'PRIVATE_KEY', remoteSidecarPath: 'C:\\tools\\sidecar.PS1' }));
			const response = invokeDoctor(tmpDir, [reachableReply, pathsReply, versionReply], ['--extension-root', extensionRoot]);
			const report = assertDoctorReport(response);
			assert.deepStrictEqual(report.checks.slice(0, 5).map(check => check.state), ['pass', 'pass', 'pass', 'pass', 'pass']);
			assert.strictEqual(report.sidecarVersion, '1.0.0');
			assert.deepStrictEqual(response.calls, ['ssh', 'remotepaths', 'sidecarversion']);
			for (const privateValue of ['private-host', 'private-user', 'PRIVATE_KEY', tmpDir]) { assert(!response.stdout.includes(privateValue)); }
			assert(!fs.existsSync(path.join(tmpDir, '.unity-vdd-shell')), 'doctor must not persist launch state');
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor human output retains stable identifiers and explicit unknown license remediation', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			writeManifest(tmpDir);
			const response = invokeDoctor(tmpDir, [reachableReply, pathsReply, versionReply], ['--format', 'human', '--shell-app', '  ' + process.execPath + '  ']);
			assert.strictEqual(response.code, 1);
			assert.strictEqual(response.stderr, '');
			for (const id of ['manifest', 'localpaths', 'ssh', 'remotepaths', 'sidecarversion']) { assert(response.stdout.includes(id + ': PASS [ok]')); }
			assert(response.stdout.includes('license: FAIL [license_probe_unavailable]'));
			assert(response.stdout.includes('licenseState: unknown'));
			assert(response.stdout.includes('outside doctor'));
			assert(!response.stdout.includes('win-vdd'));
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor rejects missing, malformed, and unsafe manifests before any transport', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			const invalid = [
				undefined, '{malformed PRIVATE_KEY',
				{}, createManifest({ sshTarget: '-oProxyCommand=PRIVATE_KEY' }), createManifest({ sshTarget: '-Ffixture@host' }),
				createManifest({ remoteWorkspacePath: 'relative-path' }),
				createManifest({ unityPlayerPath: 'C:\\private\nuser.exe' }),
				createManifest({ display: 'bad' }), createManifest({ ports: { stream: 70000, control: 70001 } }),
				createManifest({ ports: { stream: '5000junk', control: 5001 } }),
				createManifest({ vddMonitor: 1.5 }), createManifest({ remoteSidecarPath: false }),
				createManifest({ remoteSidecarPath: '' }), createManifest({ remoteWorkspacePath: '\\root-relative' }),
				createManifest({ remoteSidecarPath: 'C:\\Program Files\\Unity\\Editor\\Unity.exe' }),
				createManifest({ ffmpegPath: '*' }), createManifest({ ffmpegPath: 'relative/ffmpeg.exe' }),
				createManifest({ ffmpegPath: 'C:ffmpeg.exe' }), createManifest({ ffmpegPath: '\\ffmpeg.exe' })
			];
			for (const input of invalid) {
				const manifestPath = path.join(tmpDir, 'unity-shell.json');
				if (input === undefined) { fs.rmSync(manifestPath, { force: true }); }
				else { fs.writeFileSync(manifestPath, typeof input === 'string' ? input : JSON.stringify(input)); }
				const response = invokeDoctor(tmpDir);
				assert.strictEqual(assertDoctorReport(response).checks[0].code, 'invalid_manifest');
				assert.deepStrictEqual(response.calls, []);
				assert(!response.stdout.includes('PRIVATE_KEY'));
			}
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor refuses unresolved local dependencies and invalid output formats without SSH', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			writeManifest(tmpDir);
			for (const args of [['--shell-app', path.join(tmpDir, 'absent-secret.exe')], ['--extension-root', path.join(tmpDir, 'absent')]]) {
				const response = invokeDoctor(tmpDir, [], args);
				assert.strictEqual(assertDoctorReport(response).checks[1].code, 'local_paths_unavailable');
				assert.deepStrictEqual(response.calls, []);
			}
			const invalid = invokeDoctor(tmpDir, [], ['--format', 'unknown']);
			assert.strictEqual(invalid.code, 1);
			assert(invalid.stdout.includes('invalid_format'));
			assert.deepStrictEqual(invalid.calls, []);
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor classifies SSH failures without exposing raw host, user, or credential details', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			writeManifest(tmpDir);
			for (const [reply, code] of [
				[{ error: { code: 'ENOENT' } }, 'ssh_unavailable'],
				[{ error: { killed: true }, stderr: 'private-host' }, 'ssh_timed_out'],
				[{ error: { code: 255 }, stderr: 'private-user@private-host: Permission denied PRIVATE_KEY' }, 'ssh_auth_failed'],
				[{ error: { code: 255 }, stderr: 'Host key verification failed private-host' }, 'ssh_host_key_failed'],
				[{ error: { code: 255 }, stderr: 'Could not resolve hostname private-host' }, 'ssh_name_unresolved'],
				[{ error: { code: 255 }, stderr: 'Connection refused private-host' }, 'ssh_refused'],
				[{ data: { reachable: 'true' }, stderr: 'PRIVATE_KEY' }, 'ssh_failed']
			]) {
				const response = invokeDoctor(tmpDir, [reply]);
				const report = assertDoctorReport(response);
				assert.strictEqual(report.checks[2].code, code);
				assert.deepStrictEqual(response.calls, ['ssh']);
				for (const value of ['private-user', 'private-host', 'PRIVATE_KEY']) { assert(!response.stdout.includes(value)); }
			}
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor fails remote missing, malformed, truthy, and failed path probes before version execution', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			writeManifest(tmpDir);
			for (const reply of [
				{ data: { ...pathsReply.data, player: false } },
				{ data: { ...pathsReply.data, player: 'true' } },
				{ data: { workspace: true } }, { stdout: 'PRIVATE_KEY not json' },
				{ error: { code: 1 }, data: pathsReply.data }
			]) {
				const response = invokeDoctor(tmpDir, [reachableReply, reply]);
				assert.strictEqual(assertDoctorReport(response).checks[3].code, 'remote_paths_unavailable');
				assert.deepStrictEqual(response.calls, ['ssh', 'remotepaths']);
				assert(!response.stdout.includes('PRIVATE_KEY'));
			}
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('doctor rejects sidecar mismatches and malformed version output instead of publishing remote text', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			writeManifest(tmpDir);
			for (const [reply, expectedCode, expectedVersion] of [
				[{ data: { sidecarVersion: '2.0.0' } }, 'sidecar_version_mismatch', '2.0.0'],
				[{ data: { sidecarVersion: 'private-user@private-host PRIVATE_KEY' } }, 'sidecar_version_unavailable', null],
				[{ data: { sidecarVersion: 1 } }, 'sidecar_version_unavailable', null],
				[{ stdout: 'PRIVATE_KEY' }, 'sidecar_version_unavailable', null],
				[{ error: { code: 1 }, data: versionReply.data }, 'sidecar_version_unavailable', null]
			]) {
				const response = invokeDoctor(tmpDir, [reachableReply, pathsReply, reply]);
				const report = assertDoctorReport(response);
				assert.strictEqual(report.checks[4].code, expectedCode);
				assert.strictEqual(report.sidecarVersion, expectedVersion);
				assert(!response.stdout.includes('PRIVATE_KEY'));
			}
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('launch manifest failures point to the doctor manifest check before any process launch', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-doctor-'));
		try {
			const response = invokeDoctor(tmpDir, [], [], 'launch');
			assert.strictEqual(response.code, 1);
			assert(response.stderr.includes('[doctor:manifest]'));
			assert.deepStrictEqual(response.calls, []);
		} finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
	});
	test('sidecar VersionOnly exits before path creation, native UI APIs, and process startup', () => {
		if (process.platform !== 'win32') {
			process.stdout.write('    Windows PowerShell execution unavailable on this platform\n');
			return;
		}
		const { REMOTE_SHELL_SIDECAR_VERSION } = require(path.join(outDir, 'remote-shell', 'sidecarPlan'));
		const sidecar = path.join(repoRoot, 'unity-cursor-toolkit', 'remote-shell', 'windows', 'unity-vdd-sidecar.ps1');
		const script = "function Start-Process { throw 'Unexpected process startup' }; function Add-Type { throw 'Unexpected UI startup' }; "
			+ "function New-Item { throw 'Unexpected path creation' }; & '" + sidecar.replace(/'/g, "''") + "' -VersionOnly";
		const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
			{ encoding: 'utf8', timeout: 5_000, windowsHide: true });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout), { sidecarVersion: REMOTE_SHELL_SIDECAR_VERSION });
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
	test('remote Windows proof wrapper is wired as a package script and uses the remote manifest', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'unity-cursor-toolkit', 'package.json'), 'utf8'));
		const windowsRunnerSource = fs.readFileSync(path.join(repoRoot, 'unity-cursor-toolkit', 'scripts', 'run-windows-unity-without-editor-proof.js'), 'utf8');
		const wrapperSource = fs.readFileSync(path.join(repoRoot, 'unity-cursor-toolkit', 'scripts', 'run-remote-windows-unity-without-editor-proof.js'), 'utf8');
		const exampleManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'remote_workspace', 'unity-shell.example.json'), 'utf8'));
		assert.strictEqual(packageJson.scripts['proof:windows-unity-without-editor:preflight'], 'node scripts/run-windows-unity-without-editor-proof.js --preflight-only');
		assert.strictEqual(packageJson.scripts['proof:windows-unity-without-editor:remote'], 'node scripts/run-remote-windows-unity-without-editor-proof.js');
		assert.ok(windowsRunnerSource.includes('windows-proof-preflight.json'), 'Windows runner should write a preflight artifact');
		assert.ok(windowsRunnerSource.includes("checkCommand('cursor'"), 'preflight should check Cursor CLI availability');
		assert.ok(windowsRunnerSource.includes("checkCommand('dotnet'"), 'preflight should check dotnet availability');
		assert.ok(windowsRunnerSource.includes("checkCommand('npx'"), 'preflight should check packaged vsce availability');
		assert.ok(windowsRunnerSource.includes("checkPortAvailable('player-port'"), 'preflight should check player proof port availability');
		assert.ok(windowsRunnerSource.includes("recordArtifact('preflight'"), 'Windows proof summary should reference the preflight artifact');
		assert.ok(wrapperSource.includes('proof:windows-unity-without-editor'), 'wrapper should run the Windows proof runner remotely');
		assert.ok(wrapperSource.includes("'--preflight-only'"), 'remote wrapper should forward preflight-only mode');
		assert.ok(wrapperSource.includes('fetch-artifacts'), 'wrapper should fetch generated proof artifacts');
		assert.ok(wrapperSource.includes('remoteRepoPath'), 'wrapper should read the remote repo path from the manifest');
		assert.ok(exampleManifest.remoteRepoPath.endsWith('unity-cursor-toolkit'));
		assert.ok(exampleManifest.unityEditorPath.endsWith('Unity.exe'));
	});

	test('Windows proof import command rejects dry-runs and plans executed summaries', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'unity-cursor-toolkit', 'package.json'), 'utf8'));
		assert.strictEqual(packageJson.scripts['proof:windows-unity-without-editor:import'], 'node scripts/import-windows-unity-without-editor-proof.js');

		const scriptPath = path.join(repoRoot, 'unity-cursor-toolkit', 'scripts', 'import-windows-unity-without-editor-proof.js');
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-windows-proof-import-'));
		const bundleDir = path.join(tmpDir, '2026-06-10-windows');
		fs.mkdirSync(bundleDir, { recursive: true });
		const summaryPath = path.join(bundleDir, 'windows-proof-summary.json');
		fs.writeFileSync(summaryPath, JSON.stringify({
			schemaVersion: 1,
			mode: 'execute',
			platform: 'win32',
			windowsHost: true,
			status: 'pass'
		}, null, 2));
		fs.writeFileSync(path.join(bundleDir, 'e1-dll-mount-probe-windows.json'), '{}');

		const planned = spawnSync(process.execPath, [
			scriptPath,
			'--dry-run',
			'--from', bundleDir,
			'--dest-name', 'import-test-windows'
		], { encoding: 'utf8' });
		assert.strictEqual(planned.status, 0, planned.stderr);
		const plan = JSON.parse(planned.stdout);
		assert.strictEqual(plan.summaryPlatform, 'win32');
		assert.strictEqual(plan.summaryMode, 'execute');
		assert.ok(plan.copiedFiles.includes('windows-proof-summary.json'));

		fs.writeFileSync(summaryPath, JSON.stringify({
			schemaVersion: 1,
			mode: 'dry-run',
			platform: 'darwin',
			windowsHost: false,
			status: 'planned'
		}, null, 2));
		const rejected = spawnSync(process.execPath, [
			scriptPath,
			'--dry-run',
			'--from', bundleDir
		], { encoding: 'utf8' });
		assert.notStrictEqual(rejected.status, 0);
		assert.ok(rejected.stderr.includes('not an executed proof'));
	});

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
