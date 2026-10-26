/** Licensed local compatibility smoke. Only creates and controls its own TEMP project. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { validateCompatibilityReport } = require('./generate-capability-matrix');
const root = path.resolve(__dirname, '../..');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
function publish(file, text) { fs.writeFileSync(file + '.pending', text); fs.renameSync(file + '.pending', file); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw new Error('process_liveness_unconfirmed'); } };
function ownedProcesses(fixture) {
	if (process.platform !== 'win32') throw new Error('owned_process_enumeration_unavailable');
	const query = '$ErrorActionPreference="Stop";$p=Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match "^Unity(?:\\.exe)?$|^UnityPackageManager(?:\\.exe)?$" -and $_.CommandLine -and $_.CommandLine.Contains($env:UCT_COMPAT_PROJECT) }; ConvertTo-Json -InputObject @($p | ForEach-Object { [int]$_.ProcessId }) -Compress';
	const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', query], { env: { ...process.env, UCT_COMPAT_PROJECT: fixture }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
	if (result.status !== 0) throw new Error('owned_process_query_failed');
	const parsed = JSON.parse(result.stdout);
	if (!Array.isArray(parsed) || !parsed.every(pid => Number.isInteger(pid) && pid > 0)) throw new Error('owned_process_query_invalid');
	return parsed;
}
async function stopOwned(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null || !alive(child.pid)) return;
	if (process.platform === 'win32') {
		const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
		if (result.status !== 0 && alive(child.pid)) throw new Error('owned_cleanup_failed');
	} else child.kill('SIGKILL');
	await sleep(100);
}
function start(executable, args, options) {
	const child = spawn(executable, args, { windowsHide: true, ...options });
	const exit = new Promise(resolve => {
		child.once('error', () => resolve({ code: null, signal: null, spawnError: true }));
		child.once('exit', (code, signal) => resolve({ code, signal, spawnError: false }));
	});
	return { child, exit };
}
async function waitUntil(check, ms, processInfo) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = check();
		if (value) return value;
		if (processInfo && processInfo.child.exitCode !== null) throw new Error('editor_exited_before_ready');
		await sleep(100);
	}
	throw new Error('proof_timeout');
}
function metadataVersion(executable) {
	if (process.platform === 'win32') {
		const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:UCT_COMPAT_EDITOR).VersionInfo.ProductVersion'], { env: { ...process.env, UCT_COMPAT_EDITOR: executable }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
		if (r.status === 0) return r.stdout.trim().split('_')[0];
	} else if (process.platform === 'darwin') {
		const plist = path.resolve(path.dirname(executable), '../Info.plist');
		if (fs.existsSync(plist)) {
			const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], { encoding: 'utf8', timeout: 10000 });
			if (r.status === 0) return r.stdout.trim().split('_')[0];
		}
	}
	throw new Error('editor_metadata_unavailable');
}
function assertProjectInfo(info, ready, fixture, candidate) {
	if (!info || info.unityVersion !== candidate.editorVersion || path.resolve(info.projectPath || '') !== path.resolve(fixture) ||
		info.platform !== ready.platform || !info.runtime || typeof info.runtime.isCoreCLR !== 'boolean' ||
		typeof info.runtime.hasDomainReload !== 'boolean' || info.runtime.isCoreCLR !== ready.isCoreCLR ||
		info.runtime.hasDomainReload !== ready.hasDomainReload) throw new Error('project_identity_or_runtime_mismatch');
}
function assertListenerOwner(port, pid) {
	const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:UCT_COMPAT_PORT) -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress'], { env: { ...process.env, UCT_COMPAT_PORT: String(port) }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
	if (r.status !== 0) throw new Error('listener_owner_unavailable');
	const parsed = JSON.parse(r.stdout || '[]'), owners = Array.isArray(parsed) ? parsed : [parsed];
	if (owners.length !== 1 || owners[0] !== pid) throw new Error('listener_owner_mismatch');
}
function ownedPreferenceNames(prefix) {
	const script = String.raw`$ErrorActionPreference="Stop";$key="HKCU:\Software\Unity Technologies\Unity Editor 5.x";$names=@();if(!(Test-Path -LiteralPath $key -ErrorAction Stop)){throw "registry_missing"};if(Test-Path -LiteralPath $key -ErrorAction Stop){$names=@((Get-Item -LiteralPath $key -ErrorAction Stop).GetValueNames() | Where-Object {$_.StartsWith($env:UCT_COMPAT_PREF,[StringComparison]::Ordinal)})};ConvertTo-Json -InputObject @($names) -Compress`;
	const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, UCT_COMPAT_PREF: prefix }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
	if (r.status !== 0) throw new Error('owned_preference_query_failed');
	const names = JSON.parse(r.stdout);
	if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && name.startsWith(prefix))) throw new Error('owned_preference_query_failed');
	return names;
}
function containsConsoleMarker(text, marker) {
	return typeof text === 'string' && text.split(/\r?\n/).some(line => {
		const match = /^\[LOG\] \[[^\]\r\n]+\] (.*)$/.exec(line);
		return match && match[1] === marker;
	});
}
function ping(port) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		let text = '';
		const finish = error => { socket.destroy(); error ? reject(error) : resolve(true); };
		socket.setTimeout(5000, () => finish(new Error('handshake_timeout')));
		socket.once('error', () => finish(new Error('handshake_failed')));
		socket.once('connect', () => socket.write('{"command":"ping"}\n'));
		socket.on('data', chunk => {
			text += chunk.toString();
			if (text.length > 65536) return finish(new Error('handshake_output_limit'));
			const line = text.split('\n').find(line => line.includes('"pong"'));
			if (line) { try { if (JSON.parse(line).command === 'pong') finish(); } catch { finish(new Error('invalid_handshake')); } }
		});
	});
}
function stdioClient(port, fixture) {
	const p = start(process.execPath, [path.join(root, 'unity-cursor-toolkit/out/mcp/server.js')], {
		env: { ...process.env, UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(port), UNITY_CURSOR_TOOLKIT_PROJECT_PATH: fixture, UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: '1' },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	let next = 1, buffer = '', size = 0, stderrBytes = 0, closed = false;
	const pending = new Map();
	const settle = error => { closed = true; for (const v of pending.values()) { clearTimeout(v.timer); v.reject(error); } pending.clear(); };
	p.child.on('error', () => settle(new Error('mcp_spawn_failed')));
	p.child.stdin.on('error', () => settle(new Error('mcp_stdin_failed')));
	p.child.on('exit', () => settle(new Error('mcp_exited')));
	p.child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 1048576) settle(new Error('mcp_output_limit')); });
	p.child.stdout.on('data', data => {
		size += data.length; buffer += data.toString();
		if (size > 1048576) return settle(new Error('mcp_output_limit'));
		let i;
		while ((i = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
			try {
				const frame = JSON.parse(line), request = pending.get(frame.id);
				if (request) { clearTimeout(request.timer); pending.delete(frame.id); frame.error ? request.reject(new Error('mcp_protocol_error')) : request.resolve(frame.result); }
			} catch { settle(new Error('mcp_invalid_frame')); }
		}
	});
	return {
		...p, get stderrBytes() { return stderrBytes; },
		call(method, params) {
			if (closed) return Promise.reject(new Error('mcp_closed'));
			const id = next++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error('mcp_timeout')); }, 10000);
				pending.set(id, { resolve, reject, timer });
				p.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
			});
		}
	};
}
async function verifyCleanup() {
	const sourceFile = arg('--verify-cleanup');
	const sourceText = fs.readFileSync(sourceFile, 'utf8'), source = JSON.parse(sourceText);
	const fixture = arg('--project');
	const prefix = arg('--preference-prefix') || 'UCT_Compatibility_';
	const report = { observedAt: new Date().toISOString(), mode: 'cleanup-reassessment', sourceReport: path.basename(sourceFile),
		sourceReportSha256: hash(sourceText), originalObservedAt: source.observedAt, editorVersion: source.editorVersion, platform: source.platform,
		pid: source.pid, passed: false, historicalOverallResultUnchanged: true, mustRerunForMatrixImport: true };
	try {
		if (process.platform !== 'win32') throw new Error('owned_process_enumeration_unavailable');
		if (!Number.isInteger(source.pid) || source.pid <= 0 || source.isolation?.disposableProject !== true ||
			!fixture || !path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(fixture).startsWith('uct-compatibility-') ||
			!/^UCT_Compatibility_(?:[0-9a-f-]{36})?$/.test(prefix)) throw new Error('cleanup_scope_invalid');
		report.preferencePrefixScope = prefix === 'UCT_Compatibility_' ? 'all compatibility fixture keys' : 'one owned compatibility fixture prefix';
		report.remainingPreferenceCount = ownedPreferenceNames(prefix).length;
		report.remainingOwnedPids = ownedProcesses(fixture);
		report.pidAbsent = !alive(source.pid);
		if (report.remainingPreferenceCount) throw new Error('owned_preferences_remain');
		if (report.remainingOwnedPids.length || !report.pidAbsent) throw new Error('owned_processes_remain');
		report.passed = true;
	} catch (error) { report.error = { code: /^[a-z_]+$/.test(error.message) ? error.message : 'cleanup_unconfirmed' }; }
	const output = arg('--output') || path.join(root, 'experiments/unity-compatibility/results', 'cleanup-' + report.observedAt.replace(/[:.]/g, '-') + '.json');
	fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1;
}

async function main() {
	if (process.argv.includes('--verify-cleanup')) return verifyCleanup();
	const matrix = JSON.parse(fs.readFileSync(path.join(root, 'unity-cursor-toolkit/capability-matrix.json'), 'utf8'));
	if (process.argv.includes('--list')) { console.log(JSON.stringify({ candidates: matrix.ci.include, unconfiguredBands: matrix.bands.filter(b => !matrix.ci.include.some(c => c.band === b)), unrunState: 'untested' }, null, 2)); return; }
	const candidate = matrix.ci.include.find(c => c.id === arg('--candidate'));
	const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
	const preflight = { observedAt: new Date().toISOString(), candidateId: arg('--candidate') || '', band: candidate?.band || '', editorVersion: candidate?.editorVersion || '',
		requestedEditorVersion: candidate?.editorVersion || '', observedEditorVersion: '', platform, architecture: process.arch, passed: false, outcome: 'untested',
		checks: ['activation', 'handshake', 'console', 'mcp'].map(name => ({ name, status: 'untested' })), launched: false };
	let unity, newtonsoft, builtin;
	try {
		if (!candidate) throw new Error('configured_candidate_required');
		if (candidate.platform !== platform) throw new Error('candidate_platform_mismatch');
		if (process.platform !== 'win32') throw new Error('owned_process_enumeration_unavailable');
		unity = arg('--unity') || process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH;
		if (!unity || !fs.existsSync(unity)) throw new Error('installed_editor_required');
		preflight.observedEditorVersion = metadataVersion(unity);
		if (preflight.observedEditorVersion !== candidate.editorVersion) throw new Error('editor_version_mismatch');
		const cache = arg('--package-cache') || path.join(root, 'CursorUnityTool/Library/PackageCache');
		newtonsoft = fs.existsSync(cache) && fs.readdirSync(cache).map(name => path.join(cache, name)).find(location => {
			try { const p = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8')); return p.name === 'com.unity.nuget.newtonsoft-json' && p.version === '3.2.2'; } catch { return false; }
		});
		if (!newtonsoft) throw new Error('existing_newtonsoft_cache_required');
		builtin = path.join(path.dirname(unity), 'Data/Resources/PackageManager/BuiltInPackages');
		if (!fs.existsSync(path.join(builtin, 'com.unity.modules.jsonserialize/package.json'))) throw new Error('editor_builtin_modules_unavailable');
	} catch (error) {
		preflight.error = { code: /^[a-z_]+$/.test(error.message) ? error.message : 'preflight_failed' };
		const output = arg('--output') || path.join(root, 'experiments/unity-compatibility/results', (candidate?.id || 'unconfigured') + '-' + preflight.observedAt.replace(/[:.]/g, '-') + '.json');
		fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(preflight, null, 2) + '\n');
		console.log(JSON.stringify({ event: 'preflightRefused', output, ...preflight })); process.exitCode = 1; return;
	}
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-compatibility-'));
	const proof = path.join(fixture, 'proof');
	const report = { observedAt: new Date().toISOString(), candidateId: candidate.id, band: candidate.band, editorVersion: candidate.editorVersion, platform, architecture: process.arch,
		requestedEditorVersion: candidate.editorVersion, observedEditorVersion: preflight.observedEditorVersion, launched: false, passed: false, outcome: 'failed', normalExitConfirmed: false, remainingOwnedPids: [], checks: ['activation', 'handshake', 'console', 'mcp'].map(name => ({ name, status: 'untested' })),
		isolation: { disposableProject: true, defaultInstallActivationProven: false, port: 'OS-selected fixture port', preferenceKeys: 'two unique fixture-only keys before first import' },
		dependencies: { newtonsoft: '3.2.2 existing project cache, explicit fixture override of declared 3.2.1; no registry install', modules: 'selected Editor built-in modules' } };
	let editor, mcp, connection, prefix;
	try {
		fs.mkdirSync(proof);
		fs.mkdirSync(path.join(fixture, 'Assets/Editor'), { recursive: true });
		fs.mkdirSync(path.join(fixture, 'ProjectSettings'));
		const packageTarget = path.join(fixture, 'Packages/com.rankupgames.unity-cursor-toolkit');
		fs.cpSync(path.join(root, 'Packages/com.rankupgames.unity-cursor-toolkit'), packageTarget, { recursive: true });
		fs.cpSync(newtonsoft, path.join(fixture, 'Packages/com.unity.nuget.newtonsoft-json'), { recursive: true });
		const handlerFile = path.join(packageTarget, 'Editor/HotReloadHandler.cs');
		let source = fs.readFileSync(handlerFile, 'utf8');
		const originalHash = hash(source);
		prefix = 'UCT_Compatibility_' + crypto.randomUUID();
		if (ownedPreferenceNames(prefix).length) throw new Error('fixture_preferences_already_exist');
		for (const key of ['UnityHotReloadHandler_LastPort', 'UnityHotReloadHandler_ShowDebugLogs']) {
			if (source.split('"' + key + '"').length !== 2) throw new Error('fixture_key_substitution_mismatch');
			source = source.replace('"' + key + '"', '"' + prefix + '_' + key + '"');
		}
		fs.writeFileSync(handlerFile, source);
		report.isolation.handlerSource = { originalSha256: originalHash, fixtureSha256: hash(source), delta: 'two preference key literals only' };
		const dependencies = Object.fromEntries(fs.readdirSync(builtin).filter(name => name.startsWith('com.unity.modules.') && fs.statSync(path.join(builtin, name)).isDirectory()).map(name => {
			const p = JSON.parse(fs.readFileSync(path.join(builtin, name, 'package.json'), 'utf8')); return [p.name, p.version];
		}));
		fs.writeFileSync(path.join(fixture, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
		fs.writeFileSync(path.join(fixture, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + candidate.editorVersion + '\n');
		fs.copyFileSync(path.join(__dirname, 'UnityCompatibilitySmoke.cs'), path.join(fixture, 'Assets/Editor/UnityCompatibilitySmoke.cs'));
		editor = start(unity, ['-batchmode', '-nographics', '-projectPath', fixture, '-executeMethod', 'UnityCompatibilitySmoke.Run', '-logFile', path.join(proof, 'Editor.log')], { env: { ...process.env, UCT_COMPATIBILITY_PROOF: proof }, stdio: 'ignore' });
		if (!Number.isInteger(editor.child.pid)) throw new Error('editor_spawn_failed');
		fs.writeFileSync(path.join(proof, 'owner.pid'), String(editor.child.pid));
		report.pid = editor.child.pid; report.launched = true;
		console.log(JSON.stringify({ event: 'ownedEditorStarted', pid: report.pid, editorVersion: candidate.editorVersion, fixture }));
		const ready = await waitUntil(() => {
			if (fs.existsSync(path.join(proof, 'error.json'))) throw new Error(JSON.parse(fs.readFileSync(path.join(proof, 'error.json'), 'utf8')).code);
			if (fs.existsSync(path.join(proof, 'ready.json'))) return JSON.parse(fs.readFileSync(path.join(proof, 'ready.json'), 'utf8'));
		}, 180000, editor);
		const expectedPlatform = platform === 'Windows' ? 'WindowsEditor' : platform === 'macOS' ? 'OSXEditor' : 'LinuxEditor';
		if (ready.pid !== report.pid || ready.editorVersion !== candidate.editorVersion || ready.platform !== expectedPlatform ||
			path.resolve(ready.projectPath) !== fixture || ready.assembly !== 'UnityCursorToolkit.Editor' || !ready.assemblyMvid ||
			!Number.isInteger(ready.handlerCount) || ready.handlerCount < 1 || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 ||
			typeof ready.isCoreCLR !== 'boolean' || typeof ready.hasDomainReload !== 'boolean' || ready.isCoreCLR === ready.hasDomainReload) throw new Error('activation_identity_mismatch');
		report.identityConfirmed = true;
		report.runtime = { isCoreCLR: ready.isCoreCLR, hasDomainReload: ready.hasDomainReload };
		report.activation = { assembly: ready.assembly, assemblyMvid: ready.assemblyMvid, handlerCount: ready.handlerCount, automaticListenerObserved: ready.automaticListenerObserved, runtime: report.runtime };
		report.checks[0].status = 'pass';
		assertListenerOwner(ready.port, report.pid);
		report.listenerOwnerConfirmed = true;
		await ping(ready.port);
		const { StandaloneUnityConnection } = require('../out/mcp/standaloneConnection');
		connection = new StandaloneUnityConnection([ready.port]);
		assertProjectInfo((await connection.request('mcpToolCall', { toolName: 'project_info', args: {} })).result, ready, fixture, candidate);
		report.checks[1].status = 'pass';
		let consoleSeen = false;
		const marker = 'UCT_COMPATIBILITY_' + crypto.randomUUID();
		connection.onMessage(message => { if (message.command === 'consoleEntry' && message.payload.message === marker) consoleSeen = true; });
		publish(path.join(proof, 'console.request'), marker);
		await waitUntil(() => consoleSeen, 10000, editor);
		report.checks[2].status = 'pass';
		mcp = stdioClient(ready.port, fixture);
		const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'compatibility-proof', version: '1' } });
		if (init.protocolVersion !== '2025-06-18' || init.serverInfo.name !== 'unity-cursor-toolkit') throw new Error('mcp_initialize_mismatch');
		const list = await mcp.call('tools/list', {});
		if (!Array.isArray(list.tools) || !['project_info', 'read_console'].every(name => list.tools.some(t => t.name === name))) throw new Error('mcp_tools_missing');
		const result = await mcp.call('tools/call', { name: 'project_info', arguments: {} });
		if (result.isError || !Array.isArray(result.content) || result.content.length !== 1) throw new Error('mcp_project_info_failed');
		assertProjectInfo(JSON.parse(result.content[0].text), ready, fixture, candidate);
		const mcpMarker = 'UCT_COMPATIBILITY_' + crypto.randomUUID();
		publish(path.join(proof, 'console.request'), mcpMarker);
		let captured = false;
		for (let i = 0; i < 20 && !captured; i++) {
			const logs = await mcp.call('tools/call', { name: 'read_console', arguments: { search: mcpMarker } });
			captured = logs.isError !== true && Array.isArray(logs.content) && logs.content.some(c => containsConsoleMarker(c.text, mcpMarker));
			if (!captured) await sleep(100);
		}
		if (!captured) throw new Error('mcp_console_marker_missing');
		report.checks[3].status = 'pass';
	} catch (error) {
		report.error = { code: /^[a-z_]+$/.test(error.message) ? error.message : 'proof_failed' };
		const { redactUnityTestText } = require('../out/core/unityTestPrivacy');
		report.diagnostic = redactUnityTestText(error.message, fixture).slice(0, 500);
		report.phase = report.launched ? 'checks' : 'setup';
		const check = report.checks.find(c => c.status !== 'pass');
		if (check && report.launched) check.status = 'fail';
	} finally {
		try {
			if (connection) connection.dispose();
			if (mcp) {
				mcp.child.stdin.end();
				report.mcpExit = await Promise.race([mcp.exit, sleep(5000).then(() => null)]);
				if (!report.mcpExit) { report.forcedMcpStop = true; await stopOwned(mcp.child); report.mcpExit = await Promise.race([mcp.exit, sleep(5000).then(() => null)]); }
			}
			if (editor) {
				publish(path.join(proof, 'stop.request'), report.error ? '1' : '0');
				report.editorExit = await Promise.race([editor.exit, sleep(15000).then(() => null)]);
				if (!report.editorExit) { report.forcedEditorStop = true; await stopOwned(editor.child); report.editorExit = await Promise.race([editor.exit, sleep(5000).then(() => null)]); }
				report.normalExitConfirmed = !!report.editorExit && report.editorExit.code === 0 && report.editorExit.signal === null &&
					fs.existsSync(path.join(proof, 'quitting')) && fs.readFileSync(path.join(proof, 'quitting'), 'utf8') === String(report.pid);
				report.remainingOwnedPids = ownedProcesses(fixture);
				report.ownedPreferencesAbsent = ownedPreferenceNames(prefix).length === 0;
				report.ownedPreferenceQueryConfirmed = true;
				if (alive(report.pid) && !report.remainingOwnedPids.includes(report.pid)) report.remainingOwnedPids.push(report.pid);
			}
		} catch (error) {
			report.cleanupError = { code: /^[a-z_]+$/.test(error.message) ? error.message : 'cleanup_unconfirmed' };
			report.remainingOwnedPids = null;
			report.ownedPreferenceQueryConfirmed = false;
			for (const processInfo of [mcp, editor]) if (processInfo) {
				try { await stopOwned(processInfo.child); } catch { report.cleanupError.code = 'owned_cleanup_unconfirmed'; }
			}
		}
		report.passed = report.checks.every(c => c.status === 'pass') && report.normalExitConfirmed === true && report.ownedPreferencesAbsent === true && report.ownedPreferenceQueryConfirmed === true && !report.cleanupError && report.listenerOwnerConfirmed === true && report.mcpExit?.code === 0 &&
			report.mcpExit?.signal === null && !report.forcedMcpStop && !report.forcedEditorStop && Array.isArray(report.remainingOwnedPids) && report.remainingOwnedPids.length === 0;
		report.outcome = report.passed ? 'passed' : 'failed';
		if (report.passed) validateCompatibilityReport(report, matrix);
		const output = arg('--output') || path.join(root, 'experiments/unity-compatibility/results', candidate.id + '-' + report.observedAt.replace(/[:.]/g, '-') + '.json');
		fs.mkdirSync(path.dirname(output), { recursive: true });
		fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
		console.log(JSON.stringify({ event: 'ownedProofComplete', output, pid: report.pid, passed: report.passed, checks: report.checks, error: report.error, editorExit: report.editorExit, normalExitConfirmed: report.normalExitConfirmed, remainingOwnedPids: report.remainingOwnedPids }));
		process.exitCode = report.passed ? 0 : 1;
		// Retain the owned TEMP fixture on failure for local diagnosis; raw logs are never persisted into repository evidence.
		if (report.passed && report.remainingOwnedPids.length === 0 && fixture.startsWith(os.tmpdir() + path.sep) && path.basename(fixture).startsWith('uct-compatibility-')) fs.rmSync(fixture, { recursive: true, force: true });
	}
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ passed: false, error: { code: /^[a-z_]+$/.test(error.message) ? error.message : 'preflight_failed' } })); process.exitCode = 1; });
