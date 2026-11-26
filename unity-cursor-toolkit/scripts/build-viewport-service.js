#!/usr/bin/env node
/**
 * Builds the runtime Viewport Service player using the installed Unity Editor.
 *
 * This is licensed editor usage for the build step only. The resulting player
 * can run without an editor process or editor seat at runtime.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const exec = promisify(execFile);

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
let projectRoot = path.resolve(getStringArg('--project', path.join(repoRoot, 'CursorUnityTool')));
let outputPath = path.resolve(getStringArg('--out', defaultOutputPath()));
const unityPath = resolveUnityPath();
const target = getStringArg('--target', process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const timeoutSeconds = getIntArg('--timeout', 900);
const fixture = hasFlag('--fixture');
const force = hasFlag('--force');
const version = getStringArg('--version', '');
const revision = getStringArg('--revision', '');
const template = getStringArg('--template', '');
let proofOutput = null;
let logPath = path.join(os.tmpdir(), 'uct-build-viewport-service.log');

main().catch(error => { console.error(error.message); process.exitCode = 1; });

async function main() {
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) throw new Error('invalid_request: timeout30..1800seconds');
	if (fixture && force) throw new Error('invalid_request: --force unavailable for disposable proof');
	if (fixture) await prepareFixture();
	if (fs.existsSync(path.join(projectRoot, 'Temp/UnityLockfile')) && (fixture || !force)) throw new Error('project_locked: no force override');
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	const resultPath = path.join(projectRoot, 'build-result.json');
	const args = ['-batchmode', '-quit', '-projectPath', projectRoot, '-executeMethod',
		fixture ? 'UCTPlayerProof.CoreCLRPlayerProof.Build' : 'UnityCursorToolkit.ViewportServiceBuild.BuildFromCommandLine',
		'-uctViewportBuildPath', outputPath, '-uctViewportBuildTarget', target, '-silent-crashes', '-logFile', logPath];
	const child = spawn(unityPath, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, UCT_PLAYER_BUILD_RESULT: resultPath } });
	console.log(JSON.stringify({ pid: child.pid, project: projectRoot, player: outputPath, proofOutput }));
	const outcome = await new Promise(resolve => {
		const timer = setTimeout(() => { child.kill(); resolve({ code: null, forcedCleanup: true }); }, timeoutSeconds * 1000);
		child.once('error', error => { clearTimeout(timer); resolve({ code: null, forcedCleanup: false, launchFailure: 'editor_launch_failed: ' + error.message }); });
		child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, forcedCleanup: false }); });
	});
	if (fixture && outcome.forcedCleanup) {
		try { outcome.forcedOwnedPids = await forceOwnedEditors(); } catch (error) { outcome.cleanupFailure = error.message; }
	}
	let owned = null, cleanupError = null;
	try {
		for (let i = 0; i < 20; i++) {
			owned = await ownedEditors();
			if (!owned?.length) break;
			await new Promise(r => setTimeout(r, 250));
		}
	} catch (error) { cleanupError = error.message; }
	const rawLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
	const build = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
	const actualVersion = /Initialize engine version: ([^\r\n]+)/.exec(rawLog)?.[1] || null;
	const passed = outcome.code === 0 && !outcome.forcedCleanup && (!fixture || (owned !== null && !owned.length && !cleanupError)) && fs.existsSync(outputPath)
		&& (!fixture || (!outcome.cleanupFailure && build?.success === true && build.backend === 'CoreCLR' && build.editorCoreLibrary === 'System.Private.CoreLib'
			&& build.editorVersion === version && actualVersion === version + ' (' + revision + ')' && fs.existsSync(path.join(projectRoot, 'editor-quitting'))));
	if (fixture) {
		const report = { observedAt: new Date().toISOString(), passed, platform: process.platform, version, revision, actualVersion,
			outcome, build, cleanupError, quittingObserved: fs.existsSync(path.join(projectRoot, 'editor-quitting')), ownedEditorsRemaining: owned, template: path.basename(template), templateSha256: hash(fs.readFileSync(template)),
			renderPipelinePackageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'Packages/manifest.json'))).dependencies['com.unity.render-pipelines.universal'],
			sourceHashes: { builder: hash(fs.readFileSync(path.join(projectRoot, 'Assets/Editor/ViewportServiceBuild.cs'))),
				server: hash(fs.readFileSync(path.join(projectRoot, 'Assets/ViewportService/ViewportServiceServer.cs'))),
				fixtureHelper: hash(fs.readFileSync(path.join(projectRoot, 'Assets/CoreCLRPlayerProof.cs'))) },
			fixtureScope: 'URPsettings+current unchanged player builder/server; no toolkitEditorpackage or userEditorPrefs included', readinessClaim: false };
		fs.writeFileSync(path.join(projectRoot, 'proof-build.json'), JSON.stringify(report));
		fs.writeFileSync(path.join(proofOutput, 'build.json'), JSON.stringify(clean(report), null, 2) + '\n');
		fs.writeFileSync(path.join(proofOutput, 'Editor.log'), sanitizeLog(rawLog));
	}
	console.log(JSON.stringify({ passed, player: outputPath, ownedProject: fixture ? projectRoot : undefined, proofOutput }));
	if (!passed) process.exitCode = 1;
}

async function prepareFixture() {
	if (process.platform !== 'win32' || target !== 'windows' || !/^7000\.\d+\.\d+[abfp]\d+$/.test(version) || !/^[a-f0-9]{12}$/.test(revision))
		throw new Error('invalid_request: fixture requires exactUnity7 Windows64 version/revision');
	const product = (await ps('(Get-Item -LiteralPath ' + quote(unityPath) + ').VersionInfo.ProductVersion')).trim();
	if (product !== version + '_' + revision) throw new Error('editor_version_mismatch');
	if (!fs.existsSync(template)) throw new Error('template_unavailable');
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-player-proof-'));
	outputPath = path.join(projectRoot, 'Build/ViewportService.exe');
	logPath = path.join(projectRoot, 'Editor.log');
	proofOutput = path.resolve(getStringArg('--out-dir', path.join(repoRoot, 'experiments/player-viewport-service/results',
		new Date().toISOString().replace(/[:.]/g, '-') + '-' + version + '-' + process.platform)));
	fs.mkdirSync(proofOutput, { recursive: true });
	const prefix = 'package/ProjectData~/';
	const entries = (await exec('tar', ['-tf', template], { timeout: 15000 })).stdout.split(/\r?\n/).filter(entry => !entry.endsWith('/')
		&& (entry.startsWith(prefix + 'Assets/Settings/') || [prefix + 'ProjectSettings/GraphicsSettings.asset', prefix + 'ProjectSettings/QualitySettings.asset'].includes(entry)));
	if (!entries.includes(prefix + 'ProjectSettings/GraphicsSettings.asset') || !entries.some(entry => entry.startsWith(prefix + 'Assets/Settings/'))) throw new Error('template_invalid');
	for (const entry of entries) {
		const targetPath = path.resolve(projectRoot, entry.slice(prefix.length));
		if (!targetPath.startsWith(projectRoot + path.sep)) throw new Error('template_path_invalid');
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.writeFileSync(targetPath, (await exec('tar', ['-xOf', template, entry], { encoding: 'buffer', timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout);
	}
	const urp = JSON.parse(fs.readFileSync(path.join(path.dirname(unityPath), 'Data/Resources/PackageManager/BuiltInPackages/com.unity.render-pipelines.universal/package.json'))).version;
	const dependencies = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(repoRoot, 'CursorUnityTool/Packages/manifest.json'))).dependencies)
		.filter(([name]) => name.startsWith('com.unity.modules.') && name !== 'com.unity.modules.vr'));
	dependencies['com.unity.render-pipelines.universal'] = urp;
	fs.mkdirSync(path.join(projectRoot, 'Packages'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(projectRoot, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\nm_EditorVersionWithRevision: ' + version + ' (' + revision + ')\n');
	for (const [source, destination] of [['CursorUnityTool/Assets/Editor/ViewportServiceBuild.cs','Assets/Editor/ViewportServiceBuild.cs'],
		['CursorUnityTool/Assets/ViewportService/ViewportServiceServer.cs','Assets/ViewportService/ViewportServiceServer.cs'],
		['experiments/player-viewport-service/CoreCLRPlayerProof.cs','Assets/CoreCLRPlayerProof.cs']]) {
		const dest = path.join(projectRoot, destination); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(repoRoot, source), dest);
	}
}

async function ownedEditors() {
	if (process.platform !== 'win32') return null;
	const value = JSON.parse(await ps('[pscustomobject]@{pids=@(Get-CimInstance Win32_Process -Filter "name = \'Unity.exe\'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('
		+ quote(projectRoot) + ', [StringComparison]::OrdinalIgnoreCase) -ge0 } | Select-Object -ExpandProperty ProcessId)} | ConvertTo-Json -Compress'));
	if (!Array.isArray(value.pids) || value.pids.some(id => !Number.isInteger(id))) throw new Error('owned_editor_query_invalid');
	return value.pids;
}
async function forceOwnedEditors() {
	const resolved = path.resolve(projectRoot);
	if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-player-proof-')) throw new Error('cleanup_scope_invalid');
	const result = (await ps('$owned=@(Get-CimInstance Win32_Process -Filter "name = \'Unity.exe\'" -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq '
		+ quote(path.resolve(unityPath)) + ' -and $_.CommandLine -and $_.CommandLine.IndexOf(' + quote(resolved) + ', [StringComparison]::OrdinalIgnoreCase) -ge0 }); $owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }; [pscustomobject]@{pids=@($owned | Select-Object -ExpandProperty ProcessId)} | ConvertTo-Json -Compress')).trim();
	return JSON.parse(result).pids;
}
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function quote(text) { return "'" + text.replace(/'/g, "''") + "'"; }
async function ps(script) { return (await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000 })).stdout; }
function clean(value) {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
	if (typeof value !== 'string') return value;
	for (const [location, replacement] of [[projectRoot, '<owned-project>'], [path.dirname(unityPath), '<unity-install>'], [repoRoot, '<repository>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']])
		value = value.split(location).join(replacement).split(location.replace(/\\/g, '/')).join(replacement);
	return value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
}
function sanitizeLog(value) {
	let next = false;
	return clean(value).split(/\r?\n/).map(line => {
		if (next) { next = false; return '<private argument omitted>'; }
		if (/-hubSessionId/i.test(line)) next = true;
		const assignment = /^(\s*[A-Z][A-Z0-9_]*=)/.exec(line);
		const prefix = assignment && !/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i.test(line) ? assignment[1] : '';
		return /licens|access.?token|auth.?token|serial.?number|session.?id|correlation.?id|machine.?id|ownerToken|^\s*(?:Id|Product|Type|Expiration|User|Serial|Username|Account|ConnectionId|ConnectionKey|ContinuationId)\s*:/i.test(line)
			? '<private metadata omitted>' : prefix + line.slice(prefix.length).replace(/\b[a-z0-9_-]{32,}\b/gi, '<nonce>').replace(/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i, '<opaque-value>').trimEnd();
	}).join('\n');
}
function defaultOutputPath() {
	const root = path.join(repoRoot, 'CursorUnityTool', 'Builds', 'ViewportService');
	if (process.platform === 'darwin') {
		return path.join(root, 'ViewportService.app');
	}
	if (process.platform === 'win32') {
		return path.join(root, 'ViewportService.exe');
	}
	return path.join(root, 'ViewportService');
}

function resolveUnityPath() {
	const override = process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH || getStringArg('--unity-path', '');
	for (const candidate of expandUnityPath(override)) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
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
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error('Unity executable not found. Set --unity-path or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
}

function expandUnityPath(candidate) {
	if (!candidate) {
		return [];
	}

	const trimmed = candidate.trim();
	if (process.platform === 'darwin' && trimmed.endsWith('.app')) {
		return [path.join(trimmed, 'Contents', 'MacOS', 'Unity'), trimmed];
	}
	if (process.platform === 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity.exe'), trimmed];
	}
	return [trimmed];
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return fallback;
}

function getIntArg(name, fallback) {
	const value = Number.parseInt(getStringArg(name, ''), 10);
	return Number.isFinite(value) ? value : fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}
