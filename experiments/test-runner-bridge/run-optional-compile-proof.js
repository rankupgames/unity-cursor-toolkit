// Private RUG-556 proof: gated optional assembly, with no shipped dependency.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const revision = '6000.3.9f1', productVersion = '6000.3.9f1_7a9955a4f2fa';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const childAsmdef = {
	name: 'UCT.OptionalFrameworkCompile.Editor',
	references: ['UnityEditor.TestRunner', 'UnityEngine.TestRunner'],
	includePlatforms: ['Editor'],
	autoReferenced: true,
	defineConstraints: ['UCT_TEST_FRAMEWORK'],
	versionDefines: [{ name: 'com.unity.test-framework', expression: '1.1', define: 'UCT_TEST_FRAMEWORK' }]
};
function powershell(script) {
	const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
		{ encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error('Scoped PowerShell query failed: ' + result.stderr);
	return result.stdout.trim();
}
function scopedProcesses(fixture) {
	return JSON.parse(powershell("$root='" + fixture.replace(/'/g, "''") + "';ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Unity.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | Select-Object ProcessId,Name) -Compress"));
}
async function runCase(editor, presence) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-test-optional-'));
	const proof = path.join(fixture, 'proof'), assets = path.join(fixture, 'Assets', 'Editor');
	const output = path.join(__dirname, 'results', (presence ? 'present-' : 'absent-') + new Date().toISOString().replace(/[:.]/g, '-'));
	for (const folder of [proof, assets, path.join(assets, 'OptionalFramework'), path.join(fixture, 'Packages'), path.join(fixture, 'ProjectSettings'), output])
		fs.mkdirSync(folder, { recursive: true });
	const dependencies = { 'com.unity.modules.jsonserialize': '1.0.0' };
	if (presence) dependencies['com.unity.test-framework'] = '1.6.0';
	const toolkit = arg('--toolkit-package');
	if (toolkit) {
		const metadata = json(path.join(toolkit, 'package.json'));
		if (metadata?.name !== 'com.rankupgames.unity-cursor-toolkit') throw new Error('Exact toolkit package source required.');
		fs.cpSync(toolkit, path.join(fixture, 'Packages', metadata.name), { recursive: true });
		const builtin = path.join(path.dirname(editor), 'Data', 'Resources', 'PackageManager', 'BuiltInPackages');
		for (const name of fs.readdirSync(builtin)) {
			const pkg = json(path.join(builtin, name, 'package.json'));
			if (pkg?.name?.startsWith('com.unity.modules.')) dependencies[pkg.name] = pkg.version;
		}
	}
	fs.writeFileSync(path.join(fixture, 'Packages', 'manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(fixture, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + revision + '\n');
	fs.copyFileSync(path.join(__dirname, 'OptionalFrameworkProbe.cs'), path.join(assets, 'OptionalFrameworkProbe.cs'));
	fs.copyFileSync(path.join(__dirname, 'OptionalFrameworkChild.cs'), path.join(assets, 'OptionalFramework', 'OptionalFrameworkChild.cs'));
	fs.writeFileSync(path.join(assets, 'OptionalFramework', 'UCT.OptionalFrameworkCompile.Editor.asmdef'), JSON.stringify(childAsmdef, null, 2));
	const record = { case: presence ? 'present' : 'absent', editorVersion: revision, productVersion, childAsmdef,
		sourceHashes: ['OptionalFrameworkProbe.cs', 'OptionalFrameworkChild.cs', 'run-optional-compile-proof.js'].map(file => ({ file, sha256: hash(path.join(__dirname, file)) })),
		toolkitFullPackage: !!toolkit, shippingDependencyAdded: false, testsExecuted: false, testsCancelled: false, passed: false };
	const replacements = [[fixture, '<fixture>'], [os.homedir(), '<home>'], [os.hostname(), '<host-name>'],
		[path.dirname(editor), '<editor-directory>'], [path.dirname(path.dirname(path.dirname(editor))), '<unity-launcher>']];
	for (const address of Object.values(os.networkInterfaces()).flat()) if (address && !address.internal) replacements.push([address.address, '<owned-interface-ip>']);
	function sanitize(text, rawLog = false) {
		for (const [original, replacement] of replacements)
			for (const form of [original, original.replace(/\\/g, '/'), JSON.stringify(original).slice(1, -1)]) text = text.split(form).join(replacement);
		let hideNext = false;
		return text.split(/\r?\n/).map(line => {
			const followingHubValue = hideNext; hideNext = /-hubSessionId\s*$/i.test(line);
			return followingHubValue || /licensing|license|access.token|auth.token|serial.number|session[\s_-]*id|correlation[\s_-]*id|machine[\s_-]*id/i.test(line)
				|| (rawLog && /^[A-Za-z0-9_-]{32,}$/.test(line.trim()))
				? '<licensing, session or credential line omitted>' : line.trimEnd();
		}).join('\n').trimEnd();
	}
	function clean(value) {
		return typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean)
			: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
	}
	function save(file, value) {
		fs.writeFileSync(path.join(output, file), typeof value === 'string' ? sanitize(value, true) + '\n' : JSON.stringify(clean(value), null, 2) + '\n');
	}
	let child, exit;
	try {
		const args = ['-batchmode', '-nographics', '-quit', '-projectPath', fixture, '-logFile', path.join(proof, 'editor.log'),
			'-executeMethod', 'OptionalFrameworkProbe.Run'];
		const log = fs.openSync(path.join(proof, 'stdout.log'), 'w');
		child = spawn(editor, args, { env: { ...process.env, UCT_TEST_COMPILE_PROOF: proof }, windowsHide: true, stdio: ['ignore', log, log] });
		fs.closeSync(log);
		child.once('exit', (code, signal) => { exit = { code, signal }; });
		child.once('error', error => { exit = { error: error.message }; });
		record.pid = child.pid;
		console.log(JSON.stringify({ case: record.case, pid: child.pid, fixture, output }));
		const deadline = Date.now() + 180000;
		while (!exit && Date.now() < deadline) await sleep(200);
		if (!exit) throw new Error('Owned batch compile exceeded 180 seconds; no forced termination used.');
		record.exit = exit;
		record.observation = json(path.join(proof, 'compile.json'));
		assert.equal(exit.code, 0, 'Batch compile must exit normally.');
		assert.equal(record.observation?.pid, child.pid);
		assert.equal(record.observation.editorVersion, revision);
		assert.equal(record.observation.coreLibrary, 'mscorlib');
		assert.equal(record.observation.isMono, true);
		assert.equal(record.observation.frameworkPresent, presence);
		assert.equal(record.observation.childPresent, presence);
		assert(!record.observation.error);
		if (presence) {
			const api = JSON.parse(record.observation.childObservation);
			assert.equal(api.apiAssembly, 'UnityEditor.TestRunner');
			assert.equal(api.callbacksCompiled, true);
			assert.equal(api.typeMetadataProperty, true);
			assert.equal(api.cancelSignature, 'Boolean CancelTestRun(System.String)');
			record.childApi = api;
		}
		const logText = fs.readFileSync(path.join(proof, 'editor.log'), 'utf8');
		assert(!/\berror CS\d+|Assembly has reference to non-existent assembly/i.test(logText), 'No compile or missing-reference error.');
		record.packagesLock = json(path.join(fixture, 'Packages', 'packages-lock.json'));
		if (presence) assert.equal(record.packagesLock?.dependencies?.['com.unity.test-framework']?.version, '1.6.0');
		else assert(!record.packagesLock?.dependencies?.['com.unity.test-framework']);
		record.passed = true;
	} catch (error) { record.error = error.message; }
	finally {
		record.exit = exit;
		for (const file of fs.readdirSync(proof)) save(file, fs.readFileSync(path.join(proof, file), 'utf8'));
		record.remainingOwnedProcesses = scopedProcesses(fixture);
		record.normalEditorExit = exit?.code === 0 && fs.existsSync(path.join(proof, 'quitting')) && record.remainingOwnedProcesses.length === 0;
		if (!record.normalEditorExit) record.passed = false;
		save('observation.json', record);
		if (exit && record.remainingOwnedProcesses.length === 0) {
			const resolved = path.resolve(fixture);
			if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('uct-test-optional-'))
				throw new Error('Disposable target is outside the owned TEMP prefix.');
			fs.rmSync(resolved, { recursive: true });
		} else console.log('Retained owned fixture for normal cleanup review: ' + fixture);
		console.log(JSON.stringify({ case: record.case, passed: record.passed, normalEditorExit: record.normalEditorExit, output, error: record.error }));
	}
	return record.passed;
}
async function main() {
	const editor = arg('--editor'), chosen = arg('--case') || 'both';
	if (!editor || !['absent', 'present', 'both'].includes(chosen)) throw new Error('--editor and --case absent|present|both required.');
	const product = powershell("(Get-Item -LiteralPath '" + editor.replace(/'/g, "''") + "').VersionInfo.ProductVersion");
	if (product !== productVersion) throw new Error('Actual Editor ProductVersion differs from reviewed revision.');
	const builtin = path.join(path.dirname(editor), 'Data', 'Resources', 'PackageManager', 'BuiltInPackages', 'com.unity.test-framework', 'package.json');
	const pkg = json(builtin);
	if (pkg?.version !== '1.6.0' || pkg.unity !== '6000.0' || pkg.unityRelease !== '44f1') throw new Error('Installed built-in framework pin or minimum differs.');
	for (const presence of chosen === 'both' ? [false, true] : [chosen === 'present'])
		if (!await runCase(editor, presence)) { process.exitCode = 1; break; }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
