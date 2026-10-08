#!/usr/bin/env node
/**
 * Real EditorWindow capture/input proof. --fixture creates an owned disposable
 * project; --warm-runs 3 adds warm hidden-Editor cost runs using the existing
 * measure-editor-streaming.js path. No batchmode or user-Editor hiding.
 * node scripts/run-editor-window-capture-spike.js --fixture --unity <exe>
 *   --version <exact> --revision <exact> --template <bundled-urp.tgz>
 *   [--hide] [--warm-runs 3] [--timeout 300] [--out-dir <results>]
 * The existing sample/menu path remains available without --fixture.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(name);
const options = {
	fixture: flag('--fixture'), hide: flag('--hide'), keepOpen: flag('--keep-open'), diagnoseStartup: flag('--diagnose-startup'),
	unity: arg('--unity', process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH), version: arg('--version', ''),
	revision: arg('--revision', ''), template: arg('--template', ''), warmRuns: Number(arg('--warm-runs', 0)),
	timeout: Number(arg('--timeout', 300)), out: arg('--out-dir', ''), measureOut: arg('--measure-out', '')
};
const surfaces = ['sceneView', 'gameView', 'inspector', 'packageManager', 'customProbe'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const loadedRunnerSha256 = hash(fs.readFileSync(__filename));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let project, ownedRoot, prefs = [], templateInfo = null;
let lastChild = null;
let output;
main().catch(error => {
	const failure = cleanString(error.message);
	const saved = output || path.join(repo, 'experiments/hidden-editor-cost-baseline/results', new Date().toISOString().replace(/[:.]/g, '-') + '-' + (options.version || 'sample') + '-' + process.platform);
	fs.mkdirSync(saved, { recursive: true });
	fs.writeFileSync(path.join(saved, 'preflight-error.json'), JSON.stringify({ observedAt: new Date().toISOString(), passed: false, error: failure }, null, 2) + '\n');
	if (options.fixture && project && !lastChild) { validateOwnedRoot(); fs.rmSync(project, { recursive: true, force: true }); }
	console.error(failure); process.exitCode = 1;
});

async function main() {
	if (!Number.isInteger(options.warmRuns) || options.warmRuns < 0 || options.warmRuns > 3
		|| !Number.isFinite(options.timeout) || options.timeout < 30 || options.timeout > 600)
		throw new Error('invalid_request: warm-runs must be0..3; timeout30..600seconds');
	if (options.fixture && options.keepOpen) throw new Error('invalid_request: disposable proof requires normal shutdown');
	if (options.hide && (!options.fixture || options.warmRuns === 0)) throw new Error('invalid_request: --hide requires --fixture and --warm-runs1..3; other capture paths remain visible');
	if (options.fixture && (!/^(6000|7000)\.\d+\.\d+[abfp]\d+$/.test(options.version) || !/^[a-f0-9]{12}$/.test(options.revision)))
		throw new Error('invalid_request: fixture requires exact version and12character revision');
	project = options.fixture ? fs.mkdtempSync(path.join(os.tmpdir(), 'uct-window-proof-')) : path.join(repo, 'CursorUnityTool');
	ownedRoot = options.fixture ? project : fs.mkdtempSync(path.join(os.tmpdir(), 'uct-window-output-'));
	if (!options.unity) {
		const version = /^m_EditorVersion:\s*(.+)$/m.exec(fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1].trim();
		options.unity = process.platform === 'darwin' ? '/Applications/Unity/Hub/Editor/' + version + '/Unity.app/Contents/MacOS/Unity'
			: process.platform === 'win32' ? 'C:\\Program Files\\Unity\\Hub\\Editor\\' + version + '\\Editor\\Unity.exe' : '/opt/Unity/Hub/Editor/' + version + '/Editor/Unity';
	}
	if (!fs.existsSync(options.unity)) throw new Error('editor_unavailable: executable does not exist');
	if (fs.existsSync(path.join(project, 'Temp/UnityLockfile'))) throw new Error('project_locked: close the sample Editor before this manual spike; no force override');
	if (options.fixture) await prepareFixture();
	output = path.resolve(options.out || path.join(repo, 'experiments/hidden-editor-cost-baseline/results',
		new Date().toISOString().replace(/[:.]/g, '-') + '-' + (options.version || 'sample') + '-' + process.platform));
	fs.mkdirSync(output, { recursive: true });
	const reports = [];
	try {
		for (let index = 0; index <= options.warmRuns; index++) {
			const report = await run(index, options.warmRuns > 0 && index > 0);
			reports.push(report);
			fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(clean({
				observedAt: new Date().toISOString(), editorVersion: options.version, revision: options.revision,
				platform: process.platform, architecture: process.arch, fixture: options.fixture,
				template: templateInfo, sourceHashes: {
					runner: loadedRunnerSha256,
					sampler: hash(fs.readFileSync(path.join(__dirname, 'measure-editor-streaming.js'))),
					spike: hash(fs.readFileSync(path.join(repo, 'CursorUnityTool/Assets/Editor/UCTEditorWindowCaptureSpike.cs'))),
					capture: hash(fs.readFileSync(path.join(repo, 'Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/EditorWindowViewportCapture.cs'))),
					stream: hash(fs.readFileSync(path.join(repo, 'Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/ViewportStreamTool.cs')))
				}, runs: reports, passed: reports.every(item => item.passed), readinessClaim: false,
				limits: 'Windows interval CPU vs macOS decaying ps CPU; different platform/GPU/SRP/resolution. Mac raw baseline unavailable. No causal CoreCLR-only claim.'
			}), null, 2) + '\n');
			console.log(JSON.stringify({ output, run: index, passed: report.passed, pid: report.pid, outcome: report.outcome }));
			if (!report.passed) { process.exitCode = 1; break; }
		}
	} finally {
		if (options.fixture && lastChild?.exitCode != null && (await ownedPids()).length === 0) {
			validateOwnedRoot();
			fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		} else if (options.fixture) {
			console.error('cleanup_unconfirmed: retained owned fixture; no force termination');
			process.exitCode = 1;
		}
	}
}

async function prepareFixture() {
	validateOwnedRoot();
	if (process.platform !== 'win32') throw new Error('fixture_platform_unsupported: this exact-version disposable fixture proof is Windows-only');
	const actual = (await ps('(Get-Item -LiteralPath ' + quote(options.unity) + ').VersionInfo.ProductVersion')).trim();
	if (actual !== options.version + '_' + options.revision) throw new Error('editor_version_mismatch: actual ProductVersion differs from requested version/revision');
	if (!options.template || !fs.existsSync(options.template)) throw new Error('template_unavailable: pass the installed bundled URP template');
	const prefix = 'package/ProjectData~/';
	const list = (await exec('tar', ['-tf', options.template], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/);
	const entries = list.filter(entry => !entry.endsWith('/') && (entry.startsWith(prefix + 'Assets/Settings/')
		|| [prefix + 'ProjectSettings/GraphicsSettings.asset', prefix + 'ProjectSettings/QualitySettings.asset'].includes(entry)));
	if (!entries.includes(prefix + 'ProjectSettings/GraphicsSettings.asset') || !entries.some(e => e.startsWith(prefix + 'Assets/Settings/')))
		throw new Error('template_invalid: no configured URP settings');
	for (const entry of entries) {
		const target = path.resolve(project, entry.slice(prefix.length));
		if (!target.startsWith(project + path.sep)) throw new Error('template_invalid: escaping path');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, (await exec('tar', ['-xOf', options.template, entry], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout);
	}
	const builtin = path.join(path.dirname(options.unity), 'Data/Resources/PackageManager/BuiltInPackages/com.unity.render-pipelines.universal/package.json');
	const urp = JSON.parse(fs.readFileSync(builtin, 'utf8')).version;
	const templateManifest = JSON.parse((await exec('tar', ['-xOf', options.template, prefix + 'Packages/manifest.json'])).stdout);
	templateInfo = { name: path.basename(options.template), sha256: hash(fs.readFileSync(options.template)),
		templateUrp: templateManifest.dependencies['com.unity.render-pipelines.universal'], installedUrp: urp };
	const dependencies = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(repo, 'CursorUnityTool/Packages/manifest.json'), 'utf8')).dependencies)
		.filter(([name]) => name.startsWith('com.unity.modules.') && name !== 'com.unity.modules.vr'));
	dependencies['com.unity.render-pipelines.universal'] = urp;
	dependencies['com.rankupgames.unity-cursor-toolkit'] = 'file:com.rankupgames.unity-cursor-toolkit';
	fs.mkdirSync(path.join(project, 'Packages'), { recursive: true });
	fs.mkdirSync(path.join(project, 'Assets/Editor'), { recursive: true });
	fs.writeFileSync(path.join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + options.version + '\nm_EditorVersionWithRevision: ' + options.version + ' (' + options.revision + ')\n');
	const packageRoot = path.join(project, 'Packages/com.rankupgames.unity-cursor-toolkit');
	fs.cpSync(path.join(repo, 'Packages/com.rankupgames.unity-cursor-toolkit'), packageRoot, { recursive: true });
	fs.copyFileSync(path.join(repo, 'CursorUnityTool/Assets/Editor/UCTEditorWindowCaptureSpike.cs'), path.join(project, 'Assets/Editor/UCTEditorWindowCaptureSpike.cs'));
	const handler = path.join(packageRoot, 'Editor/HotReloadHandler.cs');
	const original = fs.readFileSync(handler, 'utf8');
	let isolated = original;
	const prefixKey = 'UCTViewportProof_' + crypto.randomBytes(8).toString('hex') + '_';
	const changes = [];
	for (const literal of ['UnityHotReloadHandler_ShowDebugLogs', 'UnityHotReloadHandler_LastPort']) {
		if (isolated.split('"' + literal + '"').length !== 2) throw new Error('isolation_source_mismatch: expected one preference literal');
		const replacement = prefixKey + literal;
		isolated = isolated.replace('"' + literal + '"', '"' + replacement + '"');
		prefs.push(replacement); changes.push({ original: literal, replacement: '<owned-prefix>' + literal });
	}
	const prefixExists = (await ps('(Get-Item -LiteralPath "HKCU:\\Software\\Unity Technologies\\Unity Editor 5.x" -ErrorAction SilentlyContinue).GetValueNames() | Where-Object { $_ -like ' + quote(prefixKey + '*') + ' }')).trim();
	if (prefixExists) throw new Error('prefs_isolation_conflict: owned prefix already exists');
	fs.writeFileSync(handler, isolated);
	templateInfo.preferenceIsolation = { changes, originalSha256: hash(original), isolatedSha256: hash(isolated), defaultInstallProof: false };
}

async function run(index, cost) {
	const directory = path.join(ownedRoot, 'run-' + index);
	fs.mkdirSync(directory, { recursive: true });
	const resultPath = path.join(directory, 'result.json'), frames = path.join(directory, 'frames'), stopPath = path.join(directory, 'stop');
	fs.mkdirSync(frames);
	const logPath = path.join(directory, 'Editor.log');
	const port = options.fixture ? await new Promise((resolve, reject) => {
		const reservation = net.createServer(); reservation.once('error', reject);
		reservation.listen(0, '127.0.0.1', () => { const selected = reservation.address().port; reservation.close(() => resolve(selected)); });
	}) : null;
	const started = Date.now();
	const args = ['-projectPath', project, '-executeMethod', 'UnityCursorToolkit.InternalSmoke.UCTEditorWindowCaptureSpike.Run',
		'-uctSpikeResultPath', resultPath, '-uctSpikeOutputDir', frames, '-uctSpikeAutoQuit', cost || options.keepOpen ? 'false' : 'true',
		'-uctSpikeOwned', options.fixture ? 'true' : 'false', '-uctSpikeStopPath', stopPath,
		'-uctSpikeTimeout', String(options.timeout), '-uctSpikePort', String(port || 0), '-uctSpikeHiddenGate', cost && options.hide ? 'true' : 'false', '-uctSpikePrefs', prefs.join(','), '-silent-crashes', '-logFile', logPath];
	lastChild = spawn(options.unity, args, { windowsHide: true, stdio: 'ignore' });
	console.log(JSON.stringify({ pid: lastChild.pid, fixture: project, phase: cost ? 'warm-cost' : 'functional-import' }));
	let outcome = null, launchError = null;
	lastChild.once('error', error => { launchError = error; });
	lastChild.once('exit', (code, signal) => { outcome = { code, signal }; });
	const report = { index, phase: cost ? 'warm-cost' : options.warmRuns ? 'unmeasured-import-functional' : 'functional',
		pid: lastChild.pid, port, startedAt: new Date(started).toISOString(), samples: [], hidden: [], result: null, errors: [], passed: false };
	let prior = null;
	let visibilityInFlight = null;
	let sampling = false;
	const sample = async () => {
		if (sampling || outcome) return;
		sampling = true;
		try {
			const metrics = await processMetrics(lastChild.pid);
			if (process.platform === 'win32' && prior && metrics.at > prior.at) metrics.cpuPercent = Number(((metrics.cpuSeconds - prior.cpuSeconds) / ((metrics.at - prior.at) / 1000) * 100).toFixed(1));
			prior = metrics;
			report.samples.push({ ...metrics, at: new Date(metrics.at).toISOString() });
		} catch (error) { report.errors.push('metrics_unavailable: ' + error.message); }
		finally { sampling = false; }
	};
	const timer = setInterval(sample, 5000);
	let visibilityTimer = null;
	let startupInspection = null;
	let inspectionTimer = null;
	if (options.diagnoseStartup && options.fixture) {
		report.startupWindows = [];
		inspectionTimer = setInterval(() => {
			if (startupInspection || outcome) return;
			startupInspection = inspectStartup(lastChild.pid).then(item => report.startupWindows.push(item)).catch(error => report.errors.push('window_inspection_failed: ' + error.message)).finally(() => startupInspection = null);
		}, 5000);
	}
	await sample();
	try {
		const deadline = started + options.timeout * 1000;
		while (!fs.existsSync(resultPath) && !outcome && !launchError && Date.now() < deadline) {
			if (cost && options.hide && report.hidden.length === 0 && fs.existsSync(path.join(frames, 'windows-ready.txt'))) {
				report.hidden.push({ ...(await hideOwned(lastChild.pid)), at: new Date().toISOString(), phase: 'before-first-frame' });
				fs.writeFileSync(path.join(frames, 'hidden-ready.txt'), 'owned hidden state confirmed');
			}
			await sleep(250);
		}
		if (launchError) throw new Error('editor_launch_failed: ' + launchError.message);
		if (!fs.existsSync(resultPath)) throw new Error('result_missing: Editor exited or timed out before result');
		// Parse before marking a result complete: malformed JSON is a failure.
		report.result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
		report.timeToResultSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
		const first = Date.parse(report.result.firstFrameAt);
		report.timeToFirstFrameSeconds = Number.isFinite(first) ? Number(((first - started) / 1000).toFixed(3)) : null;
		if (!validResult(report.result) || (options.fixture && (report.result.editorVersion !== options.version || report.result.editorPid !== lastChild.pid)))
			throw new Error('capture_smoke_failed: all five nonblank captures and changed SceneView required');
		if (options.version.startsWith('7000.') && report.result.coreLibrary !== 'System.Private.CoreLib')
			throw new Error('runtime_mismatch: Unity7 fixture did not report CoreCLR core library');
		if (cost) {
			clearInterval(timer);
			while (sampling) await sleep(50);
			if (options.hide) report.hidden.push({ ...(await hideOwned(lastChild.pid)), at: new Date().toISOString(), phase: 'before-stream' });
			report.listenerPorts = JSON.parse(await ps('@(Get-NetTCPConnection -OwningProcess ' + lastChild.pid + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique) | ConvertTo-Json -Compress'));
			if (!Array.isArray(report.listenerPorts)) report.listenerPorts = report.listenerPorts == null ? [] : [report.listenerPorts];
			// Unity also owns native listeners (including Player Connection on 55504).
			// The sampler verifies the selected listener PID and toolkit project/runtime.
			if (!report.listenerPorts.includes(port)) throw new Error('listener_isolation_failed: expected owned bridge listener');
			if (options.hide) visibilityTimer = setInterval(() => {
				if (visibilityInFlight) return;
				visibilityInFlight = inspectOwned(lastChild.pid).then(state => report.hidden.push({ ...state, at: new Date().toISOString(), phase: 'stream-sample' })).catch(error => report.errors.push('visibility_unavailable: ' + error.message)).finally(() => visibilityInFlight = null);
			}, 5000);
			const child = spawn(process.execPath, [path.join(__dirname, 'measure-editor-streaming.js'), '--pid', String(lastChild.pid),
				'--project', project, '--ports', String(port), '--editor-version', options.version, '--require-coreclr', '--out', path.join(directory, 'stream.json'),
				'--frame-out', path.join(directory, 'stream-first-frame.jpg'), '--idle-seconds', '15', '--duration', '60', '--fps', '12', '--quality', '55', '--view', 'scene', '--capture-mode', 'editorWindow'],
			{ windowsHide: true, stdio: 'ignore' });
			const code = await new Promise((resolve, reject) => {
				const guard = setTimeout(() => { child.kill(); reject(new Error('measurement_timeout: owned Node child exceeded120s')); }, 120000);
				child.once('error', error => { clearTimeout(guard); reject(error); });
				child.once('exit', code => { clearTimeout(guard); resolve(code); });
			});
			if (fs.existsSync(path.join(directory, 'stream.json'))) report.stream = JSON.parse(fs.readFileSync(path.join(directory, 'stream.json'), 'utf8'));
			if (code !== 0 || !report.stream?.success) throw new Error('stream_measurement_failed: see retained stream errors');
		}
	} catch (error) { report.errors.push(error.message); }
	finally {
		clearInterval(timer);
		clearInterval(visibilityTimer);
		clearInterval(inspectionTimer);
		if (startupInspection) await startupInspection;
		if (visibilityInFlight) await visibilityInFlight;
		while (sampling) await sleep(50);
		if (options.fixture && !outcome) fs.writeFileSync(stopPath, 'normal owned stop');
		const stopDeadline = Date.now() + 30000;
		while (!outcome && !options.keepOpen && Date.now() < stopDeadline) await sleep(250);
		if (!outcome && options.fixture) {
			report.forcedCleanup = true;
			report.forcedOwnedPids = await forceOwnedCleanup();
			const exitDeadline = Date.now() + 10000;
			while (!outcome && Date.now() < exitDeadline) await sleep(100);
		}
		report.outcome = outcome;
		if (options.fixture && outcome) {
			const names = (await ps('(Get-Item -LiteralPath "HKCU:\\Software\\Unity Technologies\\Unity Editor 5.x" -ErrorAction SilentlyContinue).GetValueNames() | Where-Object { $_ -like ' + quote(prefs[0].split('UnityHotReloadHandler_')[0] + '*') + ' }')).trim();
			report.ownedPreferenceKeysRemaining = names ? names.split(/\r?\n/).length : 0;
		}
		report.quittingObserved = fs.existsSync(path.join(frames, 'quitting.txt'));
		report.ownedPidsRemaining = options.fixture ? await ownedPids() : [];
		const rawLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		report.editorBuild = /Initialize engine version: ([^\r\n]+)/.exec(rawLog)?.[1] || null;
		report.compileErrors = [...new Set(rawLog.match(/error CS\d+:[^\r\n]+/g) || [])];
		report.passed = report.forcedCleanup !== true && report.errors.length === 0 && validResult(report.result) && report.compileErrors.length === 0
			&& (options.keepOpen || (outcome?.code === 0 && (!options.fixture || (report.quittingObserved && report.ownedPidsRemaining.length === 0 && report.ownedPreferenceKeysRemaining === 0))))
			&& (!options.fixture || report.editorBuild === options.version + ' (' + options.revision + ')')
			&& (!(cost && options.hide) || (report.hidden.length >= 2 && report.hidden.every(item => item.confirmed) && report.result.visibilityEvidence?.length === 11 && report.result.visibilityEvidence.every(item => item.enumerated && item.visible === 0)));
		const saved = path.join(output, 'run-' + index);
		fs.mkdirSync(saved, { recursive: true });
		fs.writeFileSync(path.join(saved, 'Editor.log'), sanitizeLog(rawLog));
		fs.writeFileSync(path.join(saved, 'result.json'), JSON.stringify(clean(report.result), null, 2) + '\n');
		if (report.stream) fs.writeFileSync(path.join(saved, 'stream.json'), JSON.stringify(clean(report.stream), null, 2) + '\n');
		if (fs.existsSync(path.join(directory, 'stream-first-frame.jpg'))) fs.copyFileSync(path.join(directory, 'stream-first-frame.jpg'), path.join(saved, 'stream-first-frame.jpg'));
		for (const name of surfaces) {
			const frame = path.join(frames, name + '.jpg');
			if (fs.existsSync(frame)) fs.copyFileSync(frame, path.join(saved, name + '.jpg'));
		}
	}
	if (options.measureOut) {
		fs.mkdirSync(path.dirname(path.resolve(options.measureOut)), { recursive: true });
		fs.writeFileSync(options.measureOut, JSON.stringify(clean({ schemaVersion: 1, platform: process.platform, pid: report.pid, unityPath: options.unity, projectRoot: project,
			startedAt: report.startedAt, samples: report.samples, timeToResultSeconds: report.timeToResultSeconds, timeToFirstFrameSeconds: report.timeToFirstFrameSeconds, success: report.passed, error: report.errors.join('; ') || undefined }), null, 2));
	}
	if (options.keepOpen) lastChild.unref();
	return report;
}

function validResult(result) {
	return result?.success === true && Array.isArray(result.captures) && result.captures.length === surfaces.length
		&& surfaces.every(name => result.captures.filter(c => c.window === name && c.success === true && c.distinctColors >= 8 && c.width > 0 && c.height > 0).length === 1)
		&& result.inputTest?.attempted === true && result.inputTest.changed === true && result.inputTest.rotationAngle > 0.25;
}
async function processMetrics(pid) {
	if (process.platform === 'win32') return JSON.parse(await ps('$p = Get-Process -Id ' + pid + ' -ErrorAction Stop; [pscustomobject]@{ at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rssMb=$p.WorkingSet64/1MB; cpuSeconds=$p.TotalProcessorTime.TotalSeconds } | ConvertTo-Json -Compress'));
	const parts = (await exec('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)])).stdout.trim().split(/\s+/);
	return { at: Date.now(), rssMb: Number(parts[0]) / 1024, cpuPercent: Number(parts[1]) };
}

async function inspectStartup(pid) {
	const native = [
		'using System; using System.Collections.Generic; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;',
		'public static class UCTStartupWindows {',
		'public delegate bool Callback(IntPtr h, IntPtr state);',
		'[DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr state);',
		'[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Callback cb, IntPtr state);',
		'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);',
		'[DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int max);',
		'[DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder text,int max);',
		'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
		'public static object Describe(IntPtr h,string version) { var text=new StringBuilder(4096); GetWindowText(h,text,text.Capacity); var cls=new StringBuilder(120); GetClassName(h,cls,cls.Capacity); string t=text.ToString(); var kinds=new List<string>(); foreach(string kind in new[]{"alpha","beta","terms","agreement","license","sign in","authentication","upgrade","warning","error","project","Unity"}) if(t.IndexOf(kind,StringComparison.OrdinalIgnoreCase)>=0) kinds.Add(kind); string button=""; foreach(string allowed in new[]{"OK","Cancel","Close","Accept","I agree","Continue","Retry","Yes","No","Sign in"}) if(t.Replace("&","").Trim().Equals(allowed,StringComparison.OrdinalIgnoreCase)) button=allowed; return new{className=cls.ToString(),visible=IsWindowVisible(h),textCategories=kinds.ToArray(),button=button,containsExactVersion=t.Contains(version)}; }',
		'public static object[] Read(uint target,string version) { var rows=new List<object>(); EnumWindows((h,s)=>{uint pid; GetWindowThreadProcessId(h,out pid); if(pid==target){rows.Add(Describe(h,version)); EnumChildWindows(h,(child,state)=>{uint childPid;GetWindowThreadProcessId(child,out childPid);if(childPid==target)rows.Add(Describe(child,version));return rows.Count<100;},IntPtr.Zero);} return rows.Count<100;},IntPtr.Zero);return rows.ToArray();} }'
	].join('\n');
	const script = 'Add-Type -TypeDefinition ' + quote(native) + '; @([UCTStartupWindows]::Read(' + pid + ',' + quote(options.version) + ')) | ConvertTo-Json -Depth 8 -Compress';
	const value = (await ps(script)).trim();
	const windows = value ? JSON.parse(value) : [];
	return { at: new Date().toISOString(), pid, windows: Array.isArray(windows) ? windows : [windows], rawAccountTextCaptured: false };
}
async function forceOwnedCleanup() {
	validateOwnedRoot();
	const script = '$owned = @(Get-CimInstance Win32_Process -Filter "name = \'Unity.exe\'" | Where-Object { $_.CommandLine -and $_.ExecutablePath -eq ' + quote(path.resolve(options.unity)) + ' -and $_.CommandLine.IndexOf(' + quote(project) + ',[StringComparison]::OrdinalIgnoreCase) -ge0 }); '
		+ '$owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }; @($owned | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress';
	const text = (await ps(script)).trim();
	const pids = text ? JSON.parse(text) : [];
	return Array.isArray(pids) ? pids : [pids];
}

async function inspectOwned(pid) { return ownedWindows(pid, false); }
async function hideOwned(pid) { return ownedWindows(pid, true); }
async function ownedWindows(pid, hide) {
	if (process.platform === 'darwin') {
		if (hide) await exec('osascript', ['-e', 'tell application "System Events" to set visible of (every process whose unix id is ' + pid + ') to false']);
		return { pid, requested: hide, confirmed: false, note: 'owned PID only; visibility unverified' };
	}
	if (process.platform !== 'win32') throw new Error('hide_unavailable: no supported owned-PID path');
	const script = [
		'$code = @"', 'using System; using System.Runtime.InteropServices;',
		'public static class UCTOwnedWindows {',
		'public delegate bool Callback(IntPtr h, IntPtr p);',
		'[DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);',
		'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
		'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);',
		'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
		'public static int[] Inspect(uint target, bool hide) { int matched=0, remaining=0; EnumWindows((h,p)=>{ uint pid; GetWindowThreadProcessId(h,out pid); if(pid==target) { matched++; if(hide) ShowWindow(h,0); if(IsWindowVisible(h)) remaining++; } return true; },IntPtr.Zero); return new[]{matched,remaining}; } }',
		'"@', 'Add-Type -TypeDefinition $code;',
		'$r=[UCTOwnedWindows]::Inspect(' + pid + ',' + (hide ? '$true' : '$false') + '); @{ pid=' + pid + '; matched=$r[0]; remainingVisible=$r[1] } | ConvertTo-Json -Compress'
	].join('\n');
	const result = JSON.parse(await ps(script));
	if (result.matched < 1) throw new Error('hide_unconfirmed: owned top-level windows missing');
	return { ...result, confirmed: result.remainingVisible === 0 };
}
async function ownedPids() {
	const needle = quote(project);
	const values = await ps('Get-CimInstance Win32_Process -Filter "name = \'Unity.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf(' + needle + ', [StringComparison]::OrdinalIgnoreCase) -ge0 } | Select-Object -ExpandProperty ProcessId');
	return values.trim().split(/\s+/).filter(Boolean).map(Number);
}
function validateOwnedRoot() {
	const resolved = path.resolve(project);
	if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-window-proof-'))
		throw new Error('cleanup_path_invalid: fixture outside owned TEMP prefix');
}
function quote(text) { return "'" + text.replace(/'/g, "''") + "'"; }
async function ps(script) { return (await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
function cleanString(value) {
	for (const [location, replacement] of [[project, '<owned-project>'], [ownedRoot, '<owned-output>'], [path.dirname(options.unity || ''), '<unity-install>'], [repo, '<repository>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']]) {
		if (location && location !== '.') value = value.split(location).join(replacement).split(location.replace(/\\/g, '/')).join(replacement);
	}
	return value.replace(/(?:ownerToken|SessionId|CorrelationId|MachineId)\s*["':=]+\s*["']?[a-z0-9_-]{16,}/gi, '<private-value>')
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
}
function clean(value, key = '') {
	if (Array.isArray(value)) return value.map(item => clean(item));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !/ownerToken/i.test(name)).map(([name,item]) => [name, clean(item,name)]));
	return typeof value === 'string' && !/hash|sha256/i.test(key) ? cleanString(value) : value;
}
function sanitizeLog(value) {
	let redactNext = false;
	return cleanString(value).split(/\r?\n/).map(line => {
		if (redactNext) { redactNext = false; return '<private argument omitted>'; }
		if (/-hubSessionId/i.test(line)) redactNext = true;
		const assignment = /^(\s*[A-Z][A-Z0-9_]*=)/.exec(line);
		const prefix = assignment && !/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i.test(line) ? assignment[1] : '';
		return /licens|access.?token|auth.?token|serial.?number|session.?id|correlation.?id|machine.?id|ownerToken|^\s*(?:Id|Product|Type|Expiration|User|Serial|Username|Account|ConnectionId|ConnectionKey)\s*:/i.test(line)
			? '<private or licensing line omitted>' : prefix + line.slice(prefix.length).replace(/\b[a-z0-9_-]{32,}\b/gi, '<nonce>').replace(/^\s*[a-z0-9+\/_-]{24,}={0,2}\s*$/i, '<opaque-value>').trimEnd();
	}).join('\n');
}
