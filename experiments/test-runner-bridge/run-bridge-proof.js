// Private RUG-556 production TCP proof. No user Editor or project is touched.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), net = require('net'), assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { UnityTestMcpTools } = require('../../unity-cursor-toolkit/out/mcp/unityTestTools');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const version = arg('--editor-version') || '6000.3.9f1';
const revision = arg('--editor-revision') || '7a9955a4f2fa';
const coreCLR = version.startsWith('7000.');
const listOnly = process.argv.includes('--list-only');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ps(script) {
	const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error('Scoped PowerShell query failed.');
	return result.stdout.trim();
}
class Sender {
	constructor(port) { this.port = port; this.pending = new Map(); this.progress = []; this.counter = 0; }
	async connect() {
		if (this.socket && !this.socket.destroyed) return true;
		if (this.connecting) return this.connecting;
		return this.connecting = new Promise(resolve => {
			const socket = net.createConnection({ host: '127.0.0.1', port: this.port }); let buffer = '';
			const finish = value => { this.connecting = undefined; resolve(value); };
			socket.once('connect', () => { this.socket = socket; finish(true); });
			socket.once('error', () => { socket.destroy(); finish(false); });
			socket.setTimeout(2000, () => { socket.destroy(); finish(false); });
			socket.on('data', chunk => {
				buffer += chunk.toString(); if (buffer.length > 4 * 1024 * 1024) { buffer = ''; return; }
				const lines = buffer.split('\n'); buffer = lines.pop();
				for (const line of lines) {
					let message; try { message = JSON.parse(line); } catch { continue; }
					if (message.command === 'testProgress' && this.progress.length < 25000) this.progress.push({ at: Date.now(), ...message.payload });
					if (message._requestId && this.pending.has(message._requestId)) this.pending.get(message._requestId)(message);
				}
			});
			socket.on('close', () => { if (this.socket === socket) this.socket = undefined; });
		});
	}
	async request(command, values = {}) {
		if (!await this.connect()) return null;
		if (values.toolName === 'test_runner' && values.args?.action === 'run') this.lastRun = { ...values.args };
		const id = 'proof-' + (++this.counter);
		return new Promise(resolve => {
			const timer = setTimeout(() => finish(null), 4000);
			const finish = value => { clearTimeout(timer); this.pending.delete(id); resolve(value); };
			this.pending.set(id, finish);
			this.socket.write(JSON.stringify({ command, ...values, _requestId: id }) + '\n');
		});
	}
	close() { this.socket?.destroy(); }
}
async function wait(check, ms, label, owned) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = check(); if (value) return value;
		if (owned?.exit) throw new Error(label + ': Editor exited ' + JSON.stringify(owned.exit));
		await sleep(100);
	}
	throw new Error(label + ' exceeded ' + ms + 'ms.');
}
async function run(editor, present) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-test-bridge-'));
	const proof = path.join(fixture, 'proof'), assets = path.join(fixture, 'Assets');
	const output = path.join(__dirname, 'results', (present ? 'bridge-present-' : 'bridge-absent-') + new Date().toISOString().replace(/[:.]/g, '-'));
	for (const folder of [proof, path.join(assets, 'Editor'), path.join(fixture, 'Packages'), path.join(fixture, 'ProjectSettings'), output]) fs.mkdirSync(folder, { recursive: true });
	const packageRoot = path.resolve(__dirname, '../../Packages/com.rankupgames.unity-cursor-toolkit');
	fs.cpSync(packageRoot, path.join(fixture, 'Packages', 'com.rankupgames.unity-cursor-toolkit'), { recursive: true });
	const dependencies = {};
	const builtin = path.join(path.dirname(editor), 'Data', 'Resources', 'PackageManager', 'BuiltInPackages');
	for (const name of fs.readdirSync(builtin)) { const pkg = json(path.join(builtin, name, 'package.json')); if (pkg?.name?.startsWith('com.unity.modules.')) dependencies[pkg.name] = pkg.version; }
	const frameworkVersion = json(path.join(builtin, 'com.unity.test-framework', 'package.json')).version;
	if (present) dependencies['com.unity.test-framework'] = frameworkVersion;
	fs.writeFileSync(path.join(fixture, 'Packages', 'manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(fixture, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
	fs.copyFileSync(path.join(__dirname, 'TestBridgeFixture.cs'), path.join(assets, 'Editor', 'TestBridgeFixture.cs'));
	if (present) for (const [directory, source, name, editorOnly] of [
		['EditCases', 'EditModeCases.cs', 'UCT.Proof.EditMode', true],
		['OtherCases', 'OtherAssemblyCases.cs', 'UCT.Proof.OtherEditMode', true],
		['PlayCases', 'PlayModeCases.cs', 'UCT.Proof.PlayMode', false]
	]) {
		const destination = path.join(assets, directory); fs.mkdirSync(destination);
		fs.copyFileSync(path.join(__dirname, source), path.join(destination, source));
		fs.writeFileSync(path.join(destination, name + '.asmdef'), JSON.stringify({ name,
			references: [],
			includePlatforms: editorOnly ? ['Editor'] : [], optionalUnityReferences: ['TestAssemblies'],
			autoReferenced: false }, null, 2));
	}
	if (present && !listOnly) { const observer = path.join(assets, 'Editor', 'Observer'); fs.mkdirSync(observer); fs.copyFileSync(path.join(__dirname, 'FrameworkObserver.cs'), path.join(observer, 'FrameworkObserver.cs')); fs.writeFileSync(path.join(observer, 'Observer.asmdef'), JSON.stringify({name:'UCT.Proof.Observer',references:['UnityEditor.TestRunner','UnityEngine.TestRunner'],includePlatforms:['Editor'],autoReferenced:false}, null, 2)); }
	const record = { case: present ? 'present' : 'absent', editorVersion: version, testFramework: present ? frameworkVersion : null,
		frameworkSourceHashes: ['UnityEditor.TestRunner/Api/TestRunnerApi.cs', 'UnityEditor.TestRunner/TestRun/TestJobRunner.cs', 'UnityEditor.TestRunner/TestRun/TestJobDataHolder.cs', 'UnityEditor.TestRunner/TestRun/Tasks/Events/RunFinishedInvocationEvent.cs'].map(file => ({file, sha256:hash(path.join(builtin, 'com.unity.test-framework', file))})),
		sourceHashes: ['Editor/HotReloadHandler.cs', 'Editor/MCP/Tests/TestRunnerTool.cs', 'Editor/TestRunnerIntegration/TestRunnerAdapter.cs',
			'Editor/TestRunnerIntegration/UnityCursorToolkit.TestRunnerIntegration.Editor.asmdef'].map(file => ({ file, sha256: hash(path.join(packageRoot, file)) })),
		passed: false, cases: [], debugLogsEnabled: true };
	const replacements = [[path.resolve(__dirname, '../..'), '<repository>'], [fixture, '<fixture>'], [os.homedir(), '<home>'], [os.hostname(), '<host-name>'],
		[path.dirname(editor), '<editor-directory>'], [path.dirname(path.dirname(path.dirname(editor))), '<unity-launcher>']];
	for (const address of Object.values(os.networkInterfaces()).flat()) if (address && !address.internal) replacements.push([address.address, '<owned-interface-ip>']);
	function sanitize(text, raw = false) {
		text = text.replace(/(\"ownerToken\"\s*:\s*\")[^\"]*(\")/gi, '$1<ownership-token>$2').replace(/(ownerToken\s*[:=]\s*)[^\s,;]+/gi, '$1<ownership-token>');
		for (const [old, replacement] of replacements) for (const form of [old, old.replace(/\\/g, '/'), JSON.stringify(old).slice(1, -1)]) text = text.split(form).join(replacement);
		let hideNext = false;
		return text.split(/\r?\n/).map(line => {
			const following = hideNext; hideNext = /-hubSessionId\s*$/i.test(line);
			return following || /licensing|license|access.token|auth.token|serial.number|session[\s_-]*id|correlation[\s_-]*id|machine[\s_-]*id/i.test(line)
				|| raw && /^[A-Za-z0-9_-]{32,}$/.test(line.trim()) ? '<session or credential line omitted>' : line.trimEnd();
		}).join('\n').trimEnd();
	}
	function clean(value) { return typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean)
		: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'ownerToken').map(([key, item]) => [key, clean(item)])) : value; }
	function save(file, value) { fs.writeFileSync(path.join(output, file), typeof value === 'string' ? sanitize(value, true) + '\n' : JSON.stringify(clean(value), null, 2) + '\n'); }
	function nativeEvents() { try { return fs.readFileSync(path.join(proof,'framework-events.jsonl'),'utf8').trim().split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}); } catch { return []; } }
	let owned, sender, activeController, activeOperation;
	try {
		const stdout = fs.openSync(path.join(proof, 'stdout.log'), 'w');
		const child = spawn(editor, ['-batchmode', '-nographics', '-projectPath', fixture, '-logFile', path.join(proof, 'editor.log'), '-executeMethod', 'TestBridgeFixture.Run'],
			{ env: { ...process.env, UCT_TEST_BRIDGE_PROOF: proof }, windowsHide: true, stdio: ['ignore', stdout, stdout] });
		fs.closeSync(stdout); fs.writeFileSync(path.join(proof, 'owner'), String(child.pid));
		owned = { child }; child.once('exit', (code, signal) => { owned.exit = { code, signal }; });
		child.once('error', error => { owned.exit = { error: error.message }; });
		console.log(JSON.stringify({ case: record.case, pid: child.pid, fixture, output }));
		const ready = await wait(() => json(path.join(proof, 'ready.json')), 180000, 'Fixture readiness', owned);
		assert.equal(ready.pid, child.pid); assert.equal(ready.version, version); assert.equal(ready.coreLibrary, coreCLR ? 'System.Private.CoreLib' : 'mscorlib'); assert.equal(ready.isMono, !coreCLR);
		record.ready = ready;
		sender = new Sender(ready.port);
		let capabilities;
		for (let i = 0; i < 10 && !capabilities; i++) { capabilities = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'capabilities', projectPath: fixture } }))?.result; if (!capabilities) await sleep(500); }
		assert(capabilities); record.capabilities = capabilities; assert.equal(capabilities.success, true); assert.equal(capabilities.available, present);
		assert.equal(capabilities.projectPath, fixture); assert.equal(capabilities.editorPid, child.pid);
		if (!present) {
			const unavailable = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'list', mode: 'EditMode', projectPath: fixture,
				editorPid: child.pid, ownerToken: crypto.randomBytes(32).toString('hex'), runId: crypto.randomBytes(16).toString('hex') } }))?.result;
			assert.equal(unavailable?.error?.code, 'test_framework_unavailable'); assert.equal(unavailable.success, false);
			record.cases.push({ name: 'missing-framework', result: unavailable });
		} else {
			assert.equal(capabilities.supportsCancellation, true);
			const provider = new UnityTestMcpTools(sender, () => fixture);
			const execute = async (name, args, expectation, context) => {
				const result = await provider.execute(name, { backend: 'bridge', timeoutMs: 60000, ...args }, context);
				record.cases.push({ name: expectation, args, result }); return result;
			};
			const list = await execute('list_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', namespace: 'BridgeProof.Scope' } }, 'list-without-execution');
			assert.equal(list.status, 'listed'); assert.equal(list.summary.total, 7); assert.equal(list.summary.notRun, 7);
			assert(list.tests.every(test => test.status === 'not_run' && test.durationMs === 0 && test.message === '' && test.stackTrace === ''));
			assert(!list.error); assert(!fs.existsSync(path.join(proof, 'unexpected-cross-assembly')));
			if (!listOnly) {
			const literalName = list.selection.find(name => name.includes('Literal[1].*')); assert(literalName);
			const literal = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', test: literalName, category: 'literal' } }, 'literal-metacharacter-name');
			assert.equal(literal.status, 'completed'); assert.deepEqual(literal.selection, [literalName]); assert.equal(literal.summary.passed, 1);
			const pass = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', namespace: 'BridgeProof.Scope', category: 'pass' } }, 'and-namespace-descendants');
			assert.equal(pass.summary.total, 2); assert.equal(pass.summary.passed, 2);
			const ambiguous = await execute('run_tests', { mode: 'EditMode', filter: { namespace: 'BridgeProof.Scope', category: 'pass' } }, 'cartesian-scope-refused');
			assert.equal(ambiguous.error?.code, 'test_selection_ambiguous'); assert(!fs.existsSync(path.join(proof, 'unexpected-cross-assembly')));
			const failed = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', test: 'BridgeProof.Scope.Arithmetic.Failing' } }, 'failure-stack');
			assert.equal(failed.status, 'failed'); assert.equal(failed.summary.failed, 1);
			assert(failed.tests[0].message.includes('UCT_EXPECTED_FAILURE_STACK')); assert(failed.tests[0].stackTrace.includes('Failing'));
			for (const [test, status, count] of [['Skipped', 'skipped', 'skipped'], ['Inconclusive', 'inconclusive', 'inconclusive']]) {
				const outcome = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', test: 'BridgeProof.Scope.Arithmetic.' + test } }, status + '-mapping');
				assert.equal(outcome.tests[0].status, status); assert.equal(outcome.summary[count], 1);
			}
			const tooLarge = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', test: 'BridgeProof.Scope.Arithmetic.Oversize' } }, 'oversize-explicit-error');
			assert.equal(tooLarge.status, 'error'); assert.equal(tooLarge.error?.code, 'result_too_large'); assert.equal(tooLarge.tests.length, 0);
			const play = await execute('run_tests', { mode: 'PlayMode', filter: { test: 'BridgeProof.Play.Waiting.Heartbeats' } }, 'play-reload-and-heartbeat');
			assert.equal(play.status, 'completed'); assert.equal(play.summary.passed, 1);
			const heartbeats = sender.progress.filter(item => item.runId === play.runId && item.phase === 'heartbeat');
			assert(heartbeats.length >= 2, 'PlayMode requires live heartbeats after reload.');
			const controller = new AbortController(); activeController = controller;
			const cancelStartedAfter = Date.now();
			const operation = activeOperation = execute('run_tests', { mode: 'PlayMode', filter: { test: 'BridgeProof.Play.Waiting.CancelOwned' } }, 'owned-native-cancellation', { signal: controller.signal });
			const cancelStarted = await wait(() => nativeEvents().find(event => event.callback === 'testStarted' && event.fullName === 'BridgeProof.Play.Waiting.CancelOwned' && Date.parse(event.at) >= cancelStartedAfter), 30000, 'Owned native cancellation target start', owned);
			record.nativeCancellationStartedEvent = cancelStarted;
			const owner = sender.lastRun;
			for (const change of [{ ownerToken: 'wrong-' + crypto.randomBytes(32).toString('hex') }, { editorPid: child.pid + 1 }, { projectPath: path.join(fixture, 'wrong-project') }]) {
				const refusal = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: {
					action: 'cancel', mode: owner.mode, runId: owner.runId, projectPath: owner.projectPath, editorPid: owner.editorPid, ownerToken: owner.ownerToken, ...change
				} }))?.result;
				assert.equal(refusal?.error?.code, 'test_job_owner_mismatch'); assert.equal(refusal.workStopped, false);
				record.cases.push({ name: 'mismatched-owner-refused', result: refusal });
			}
			controller.abort();
			const cancelled = await operation; activeOperation = undefined; activeController = undefined; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error?.code, 'cancelled');
			const nativeCancelled = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: {
				action: 'status', mode: owner.mode, runId: owner.runId, projectPath: owner.projectPath, editorPid: owner.editorPid, ownerToken: owner.ownerToken
			} }))?.result;
			record.cases.push({ name: 'native-cancellation-confirmed', result: nativeCancelled });
			assert.equal(nativeCancelled?.status, 'cancelled'); assert.equal(nativeCancelled.workStopped, true);
			assert.equal(nativeCancelled.tests[0].status, 'not_run'); assert.equal(nativeCancelled.summary.notRun, 1);
			const afterCancel = await execute('run_tests', { mode: 'EditMode', filter: { assembly: 'UCT.Proof.EditMode', test: literalName } }, 'next-run-after-confirmed-cancellation');
			assert.equal(afterCancel.status, 'completed'); assert.equal(afterCancel.summary.passed, 1);
			const deadlineOwner = { mode: 'PlayMode', runId: 'deadline-' + crypto.randomBytes(16).toString('hex'), ownerToken: crypto.randomBytes(32).toString('hex'), projectPath: fixture, editorPid: child.pid };
			const nativeStartedAfter = Date.now();
			const begun = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'run', ...deadlineOwner, timeoutMs: 10000, filter: { test: 'BridgeProof.Play.Waiting.CancelOwned' } } }))?.result;
			assert(begun && !begun.error);
			let nativeStartedEvent;
			const startLimit = Date.now() + 8000;
			while (Date.now() < startLimit) {
				// Polling rebinds the facade sink after Mono reload, as the production provider does.
				await sender.request('mcpToolCall', {toolName:'test_runner',args:{action:'status',...deadlineOwner}});
				const events = nativeEvents();
				nativeStartedEvent = events.find(event=>event.callback==='testStarted' && event.fullName==='BridgeProof.Play.Waiting.CancelOwned' && Date.parse(event.at)>=nativeStartedAfter);
				if (nativeStartedEvent) break;
				await sleep(250);
			}
			assert(nativeStartedEvent,'Native timeout test must actually start before deadline.');
			record.nativeTimeoutStartedEvent=nativeStartedEvent;
			let nativeTimeout;
			const timeoutLimit = Date.now() + 30000;
			while (Date.now() < timeoutLimit) {
				nativeTimeout = (await sender.request('mcpToolCall', { toolName: 'test_runner', args: { action: 'status', ...deadlineOwner } }))?.result;
				if (nativeTimeout?.status === 'timed_out' && nativeTimeout.workStopped === true) break;
				await sleep(500);
			}
			record.cases.push({name:'native-deadline-confirmed-after-execution-start', result:nativeTimeout});
			assert.equal(nativeTimeout?.status, 'timed_out'); assert.equal(nativeTimeout.workStopped, true); assert.equal(nativeTimeout.error?.code, 'test_job_timed_out');
			const afterDeadline = await execute('run_tests', { mode:'EditMode', filter:{assembly:'UCT.Proof.EditMode', test:literalName} }, 'next-run-after-confirmed-timeout');
			assert.equal(afterDeadline.status,'completed');
			record.progress = sender.progress;
			for (const runId of new Set(sender.progress.map(item => item.runId))) {
				const sequence = sender.progress.filter(item => item.runId === runId).map(item => item.sequence);
				assert(sequence.every((item, i) => i === 0 || item > sequence[i - 1]), 'Progress sequence must increase across reload.');
			}
			}
		}
		record.passed = true;
	} catch (error) { record.error = { message: error.message, stack: error.stack }; }
	finally {
		if (activeOperation) { activeController.abort(); await Promise.race([activeOperation.catch(()=>{}), sleep(18000)]); }
		record.progress = sender?.progress || [];
		sender?.close(); fs.writeFileSync(path.join(proof, 'stop'), '');
		if (owned) try { await wait(() => owned.exit, 30000, 'Owned normal shutdown'); record.exit = owned.exit; } catch (error) { record.cleanupError = error.message; }
		const rawLogs = ['editor.log', 'stdout.log'].map(file => { try { return fs.readFileSync(path.join(proof, file), 'utf8'); } catch { return ''; } }).join('\n');
		record.rawOwnerTokenValueCount = (rawLogs.match(/\"ownerToken\"\s*:\s*\"[^\"]+\"/gi) || []).length;
		record.rawOwnerTokenLoggingObserved = record.rawOwnerTokenValueCount > 0;
		if (record.rawOwnerTokenLoggingObserved) record.passed = false;
		for (const file of fs.readdirSync(proof)) if (!['owner', 'stop'].includes(file)) save(file, fs.readFileSync(path.join(proof, file), 'utf8'));
		record.remainingOwnedProcesses = JSON.parse(ps("$root='" + fixture.replace(/'/g, "''") + "';ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Unity.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | Select-Object ProcessId,Name) -Compress"));
		record.normalEditorExit = record.exit?.code === 0 && fs.existsSync(path.join(proof, 'quitting')) && record.remainingOwnedProcesses.length === 0;
		if (!record.normalEditorExit) record.passed = false;
		save('observation.json', record);
		const retainForCli = present && record.passed && process.argv.includes('--keep-for-cli');
		if (record.exit && record.remainingOwnedProcesses.length === 0 && !retainForCli) {
			const resolved = path.resolve(fixture);
			if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('uct-test-bridge-')) throw new Error('Unexpected disposable target.');
			fs.rmSync(resolved, { recursive: true });
		}
		console.log(JSON.stringify({ passed: record.passed, normalEditorExit: record.normalEditorExit, output, error: record.error?.message, retainedForCli: retainForCli ? fixture : undefined }));
	}
	return record.passed;
}
async function main() {
	const editor = arg('--editor'), chosen = arg('--case') || 'both';
	if (!editor || !['both', 'absent', 'present'].includes(chosen)) throw new Error('Reviewed --editor and --case both|absent|present required.');
	assert.equal(ps("(Get-Item -LiteralPath '" + editor.replace(/'/g, "''") + "').VersionInfo.ProductVersion"), version + '_' + revision);
	for (const present of chosen === 'both' ? [false, true] : [chosen === 'present']) if (!await run(editor, present)) { process.exitCode = 1; break; }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
