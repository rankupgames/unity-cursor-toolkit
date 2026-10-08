// node run-lifecycle-probe.js --unity <Unity 7 executable> --version <Editor version> [--production-package]
// Creates a disposable project; never loads or closes a user project.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function main() {
	const unityArgument = process.argv.indexOf('--unity');
	const unityPath = unityArgument < 0 ? process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH : process.argv[unityArgument + 1];
	if (!unityPath || !fs.existsSync(unityPath)) throw new Error('Pass an installed Unity 7 executable with --unity or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
	const versionArgument = process.argv.indexOf('--version');
	const version = versionArgument < 0 ? undefined : process.argv[versionArgument + 1];
	if (!version || !/^7000\.[0-9]+\.[0-9]+[abfp][0-9]+$/.test(version)) throw new Error('Pass the installed Unity 7 Editor version with --version.');
	const production = process.argv.includes('--production-package');
	const consoleBaseline = process.argv.includes('--console-reset-baseline');
	if (consoleBaseline && !production) throw new Error('--console-reset-baseline requires --production-package.');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-unity7-lifecycle-'));
	const eventsPath = path.join(fixture, 'events.jsonl');
	const logPath = path.join(fixture, 'Editor.log');
	let exited = false;
	try {
		fs.mkdirSync(path.join(fixture, 'Assets/Editor'), { recursive: true });
		fs.mkdirSync(path.join(fixture, 'Packages'));
		fs.mkdirSync(path.join(fixture, 'ProjectSettings'));
		fs.writeFileSync(path.join(fixture, 'Packages/manifest.json'), '{"dependencies":{}}');
		if (production) {
			const source = path.resolve(__dirname, '../../Packages/com.rankupgames.unity-cursor-toolkit');
			fs.cpSync(source, path.join(fixture, 'Packages/com.rankupgames.unity-cursor-toolkit'), { recursive: true });
			if (consoleBaseline) {
				// Reproduce the previous entered-mode behavior in this disposable snapshot only.
				const consolePath = path.join(fixture, 'Packages/com.rankupgames.unity-cursor-toolkit/Editor/ConsoleToCursor.cs');
				const text = fs.readFileSync(consolePath, 'utf8').replace(/\r\n/g, '\n');
				const current = '\t\t\tcaptureInitialized = false;\n\t\t\tInitializeCapture();';
				if (!text.includes(current)) throw new Error('The console baseline replacement no longer matches the entered-mode reset.');
				fs.writeFileSync(consolePath, text.replace(current, '\t\t\tResetBuffer();'));
			}
			fs.mkdirSync(path.join(fixture, 'Assets/Reloadable/Editor'), { recursive: true });
			fs.writeFileSync(path.join(fixture, 'Assets/Editor/UCT.CoordinatorProof.asmdef'), JSON.stringify({ name: 'UCT.CoordinatorProof', includePlatforms: ['Editor'] }));
			fs.writeFileSync(path.join(fixture, 'Assets/Reloadable/Editor/UCT.ReloadableProof.asmdef'), JSON.stringify({ name: 'UCT.ReloadableProof', references: ['UnityCursorToolkit.Editor'], includePlatforms: ['Editor'] }));
			fs.writeFileSync(path.join(fixture, 'Assets/Reloadable/Editor/ReloadableHandler.cs'), 'using System; using UnityCursorToolkit.Core; [MCPTool("uct_lifecycle_fixture")] public sealed class ReloadableHandler : IToolHandler { public const int Revision = 0; public readonly string InstanceId = Guid.NewGuid().ToString("N"); public string ToolName => "uct_lifecycle_fixture"; public string Description => "Disposable reload fixture"; public string HandleCommand(string json) { return "{\\"success\\":true,\\"revision\\":" + Revision + ",\\"instance\\":\\"" + InstanceId + "\\"}"; } }'.replace(/\\"/g, '\\"'));
		}
		fs.writeFileSync(path.join(fixture, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
		const probe = production ? 'ProductionLifecycleProbe' : 'LifecycleProbe';
		fs.copyFileSync(path.join(__dirname, probe + '.cs'), path.join(fixture, 'Assets/Editor/' + probe + '.cs'));
		if (!production) fs.writeFileSync(path.join(fixture, 'Assets/Editor/RecompiledMarker.cs'), 'public static class RecompiledMarker { public const int Revision = 0; }');
		const child = spawn(unityPath, ['-batchmode', ...(production ? [] : ['-nographics']), '-projectPath', fixture,
			'-executeMethod', probe + '.Run', '-logFile', logPath], {
			env: { ...process.env, UCT_LIFECYCLE_EVIDENCE_PATH: eventsPath, UCT_LIFECYCLE_EDITOR_VERSION: version }, windowsHide: true, stdio: 'ignore'
		});
		fs.writeFileSync(eventsPath + '.owner', String(child.pid));
		console.log(JSON.stringify({ pid: child.pid, projectPath: fixture, unityPath }));
		const outcome = await new Promise((resolve, reject) => {
			let stop, deadline, phase = 'startup';
			const budget = milliseconds => {
				clearTimeout(stop); clearTimeout(deadline);
				stop = setTimeout(() => fs.writeFileSync(eventsPath + '.stop', 'normal exit requested'), milliseconds);
				deadline = setTimeout(() => {
					clearInterval(observeStartup);
					child.unref();
					resolve({ code: null, signal: null, normalExit: false, timeout: true, phase });
				}, milliseconds + 15000);
			};
			const observeStartup = setInterval(() => {
				if (phase === 'startup' && fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > 0) {
					phase = 'execution'; budget(90000);
				}
			}, 250);
			budget(180000);
			child.once('error', error => {
				exited = true; clearTimeout(stop); clearTimeout(deadline); clearInterval(observeStartup); reject(error);
			});
			child.once('exit', (code, signal) => {
				exited = true; clearTimeout(stop); clearTimeout(deadline); clearInterval(observeStartup);
				resolve({ code, signal, normalExit: signal === null && Number.isInteger(code) && code >= 0 && code <= 255, timeout: false, phase });
			});
		});
		const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
		const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
		const sanitize = value => {
			for (const [location, label] of [[fixture, '<disposable-project>'], [unityPath, '<unity-executable>'],
				[path.dirname(unityPath), '<unity-install>'], [os.homedir(), '<user-home>']]) {
				value = value.split(location).join(label).split(location.split(path.sep).join('/')).join(label);
			}
			return value.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gmi, '<session argument omitted>')
				.split(/\r?\n/).map(line => /licensing|license|access.token|auth.token|serial.number|machine.?id|session.?id|correlation.?id|bearer|hardware.?id|user.?id|account.?id/i.test(line)
					|| /^\s*(?:Id|Product|Type|Expiration):/i.test(line) || /^[A-Za-z0-9+\/=_-]{32,}$/.test(line.trim())
					? '<licensing or credential line omitted>' : line.trimEnd()).join('\n');
		};
		const cleanEvent = value => typeof value === 'string' ? sanitize(value) : Array.isArray(value)
			? value.map(cleanEvent) : value && typeof value === 'object'
				? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanEvent(item)])) : value;
		for (let index = 0; index < events.length; index++) events[index] = cleanEvent(events[index]);
		const ownerEvents = events.filter(event => event.pid === child.pid);
		const completed = ownerEvents.some(event => event.callback === 'complete')
			&& (production
				? [0, 1, 2].every(revision => ownerEvents.some(event => event.callback === 'networkVerified' && event.revision === revision))
					&& ownerEvents.some(event => event.callback === 'joinFailureVisible')
					&& ownerEvents.some(event => event.callback === 'shutdownWorkers' && event.stopped)
				: [1, 2].every(revision => ownerEvents.some(event => event.callback === 'revisionObserved' + revision))
					&& ownerEvents.some(event => event.callback === 'playMode:EnteredPlayMode' && event.domainReloadDisabled));
		const report = {
			observedAt: new Date().toISOString(), consoleResetBaseline: consoleBaseline, fixture: production ? 'canonical package snapshot, only separate Assets handler recompiled' : 'standalone, no toolkit package', pid: child.pid,
			outcome, completed, readinessClaim: false, events,
			passed: completed && outcome.normalExit && outcome.code === 0,
			deadlines: { startupSeconds: 180, executionSeconds: 90, normalExitGraceSeconds: 15 },
			scope: 'Single installed Editor observation. Callback order is evidence, not a general lifecycle guarantee. Production frame delivery does not prove viewport pixel validity.'
		};
		const stamp = report.observedAt.replace(/[:.]/g, '-');
		const output = path.join(__dirname, 'results', (consoleBaseline ? 'unity7-console-reset-baseline-' : production ? 'unity7-package-lifecycle-' : 'unity7-lifecycle-') + stamp);
		fs.mkdirSync(output, { recursive: true });
		fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(report, null, 2) + '\n');
		fs.writeFileSync(path.join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
		fs.writeFileSync(path.join(output, 'Editor.log'), sanitize(log));
		console.log(JSON.stringify({ output, completed, outcome, eventCount: events.length }));
		if (!outcome.normalExit) {
			console.error('Owned proof Editor did not exit normally; ' + (exited ? 'process exited abnormally.' : 'left running. Project: ' + fixture + ' PID: ' + child.pid));
		}
		if (!completed || outcome.code !== 0) process.exitCode = 1;
	} finally {
		// Never delete a fixture that a live proof Editor still uses.
		if (exited) {
			const resolved = path.resolve(fixture);
			if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-unity7-lifecycle-')) {
				throw new Error('Disposable fixture cleanup path is outside the intended temporary root.');
			}
			try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
			catch (error) { console.error('Disposable fixture cleanup pending: ' + resolved + ': ' + error.message); }
		}
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
