// Reproduce the toolkit smoke with the URP assets bundled with a Unity 7 Editor.
// node run-render-smoke.js --unity <Unity.exe> --version <version> --template <urp-template.tgz>
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

async function main() {
	const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
	const unity = argument('--unity'), version = argument('--version'), template = argument('--template');
	if (!unity || !template || !fs.existsSync(unity) || !fs.existsSync(template)
		|| !/^7000\.[0-9]+\.[0-9]+[abfp][0-9]+$/.test(version || '')) {
		throw new Error('Pass an installed Unity 7 executable, its exact version, and its bundled URP template.');
	}
	const repository = path.resolve(__dirname, '../..');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-urp-smoke-'));
	const prefix = 'package/ProjectData~/';
	const templateManifest = JSON.parse(execFileSync('tar', ['-xOf', template, prefix + 'Packages/manifest.json'], { encoding: 'utf8' }));
	const urp = templateManifest.dependencies['com.unity.render-pipelines.universal'];
	if (!/^\d+\.\d+\.\d+$/.test(urp || '')) throw new Error('Template has no exact URP version.');
	const entries = execFileSync('tar', ['-tf', template], { encoding: 'utf8' }).split(/\r?\n/)
		.filter(entry => !entry.endsWith('/') && (entry.startsWith(prefix + 'Assets/Settings/')
			|| [prefix + 'ProjectSettings/GraphicsSettings.asset', prefix + 'ProjectSettings/QualitySettings.asset'].includes(entry)));
	if (!entries.includes(prefix + 'ProjectSettings/GraphicsSettings.asset') || !entries.some(entry => entry.startsWith(prefix + 'Assets/Settings/'))) {
		throw new Error('Template has no configured render pipeline assets.');
	}
	for (const entry of entries) {
		const target = path.resolve(fixture, entry.slice(prefix.length));
		if (!target.startsWith(fixture + path.sep)) throw new Error('Template entry escapes the disposable project.');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, execFileSync('tar', ['-xOf', template, entry]));
	}
	const dependencies = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(repository, 'CursorUnityTool/Packages/manifest.json'), 'utf8')).dependencies)
		.filter(([name]) => name.startsWith('com.unity.modules.') && name !== 'com.unity.modules.vr'));
	dependencies['com.unity.render-pipelines.universal'] = urp;
	dependencies['com.rankupgames.unity-cursor-toolkit'] = 'file:com.rankupgames.unity-cursor-toolkit';
	fs.mkdirSync(path.join(fixture, 'Packages'), { recursive: true });
	fs.mkdirSync(path.join(fixture, 'Assets/Editor'), { recursive: true });
	fs.writeFileSync(path.join(fixture, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(fixture, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
	fs.cpSync(path.join(repository, 'Packages/com.rankupgames.unity-cursor-toolkit'), path.join(fixture, 'Packages/com.rankupgames.unity-cursor-toolkit'), { recursive: true });
	fs.copyFileSync(path.join(repository, 'CursorUnityTool/Assets/Editor/UnityCursorToolkitInternalSmoke.cs'), path.join(fixture, 'Assets/Editor/UnityCursorToolkitInternalSmoke.cs'));
	const log = path.join(fixture, 'Editor.log'), result = path.join(fixture, 'result.json'), frame = path.join(fixture, 'viewport.jpg');
	const args = ['-batchmode', '-projectPath', fixture, '-executeMethod', 'UnityCursorToolkit.InternalSmoke.UnityCursorToolkitInternalSmoke.Run',
		'-uctSmokeResultPath', result, '-uctSmokeViewportFramePath', frame, '-logFile', log];
	const child = spawn(unity, args, { windowsHide: true, stdio: 'ignore' });
	console.log(JSON.stringify({ pid: child.pid, fixture }));
	const outcome = await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			child.unref(); resolve({ code: null, signal: null, timeout: true });
		}, 300000);
		child.once('error', error => { clearTimeout(deadline); reject(error); });
		child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal, timeout: false }); });
	});
	const clean = value => {
		for (const [location, replacement] of [[fixture, '<disposable-project>'], [path.dirname(unity), '<unity-install>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host>']]) {
			value = value.split(location).join(replacement).split(location.split(path.sep).join('/')).join(replacement);
		}
		return value.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gmi, '<session argument omitted>')
			.split(/\r?\n/).map(line => /licensing|license|access.token|auth.token|serial.number|machine.?id|session.?id|correlation.?id|bearer|hardware.?id|user.?id|account.?id/i.test(line)
				|| /^\s*(?:Id|Product|Type|Expiration):/i.test(line) || /^[A-Za-z0-9+\/=_-]{32,}$/.test(line.trim())
			? '<licensing or credential line omitted>' : line.replace(/\[IP\] [^ ]+/g, '[IP] <host-address>').trimEnd()).join('\n');
	};
	const smoke = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null;
	if (smoke?.viewportFramePath) smoke.viewportFramePath = clean(smoke.viewportFramePath);
	const rawLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
	const editorBuild = /Initialize engine version: ([^\r\n]+)/.exec(rawLog)?.[1];
	const report = { observedAt: new Date().toISOString(), editorVersion: version, editorBuild, platform: process.platform, architecture: process.arch,
		renderPipeline: urp, templateName: path.basename(template), templateSha256: crypto.createHash('sha256').update(fs.readFileSync(template)).digest('hex'),
		outcome, smoke, passed: outcome.code === 0 && smoke?.success === true && editorBuild?.startsWith(version + ' (') === true, readinessClaim: false,
		arguments: args.map(value => clean(value)), scope: 'Disposable URP fixture and current package snapshot; no user project upgrade or capture-code substitution.' };
	const output = path.join(__dirname, 'results', 'unity7-urp-smoke-' + report.observedAt.replace(/[:.]/g, '-'));
	fs.mkdirSync(output, { recursive: true });
	fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(report, null, 2) + '\n');
	if (fs.existsSync(log)) fs.writeFileSync(path.join(output, 'Editor.log'), clean(fs.readFileSync(log, 'utf8')));
	if (fs.existsSync(frame)) fs.copyFileSync(frame, path.join(output, 'viewport.jpg'));
	console.log(JSON.stringify({ output, passed: report.passed, outcome }));
	if (outcome.timeout) console.error('Owned proof Editor exceeded the deadline; left running at PID ' + child.pid + ', project ' + fixture);
	if (!report.passed) process.exitCode = 1;
	if (!outcome.timeout) {
		if (!fixture.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(fixture).startsWith('uct-urp-smoke-')) throw new Error('Invalid cleanup path.');
		fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
