// Private RUG-535 owned-fixture proof. Run --policy-tests before --editor.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { RelayClient, provider, requireEditorVersion } = require('./relay-provider');
const VERSION = '2.20.0-pre.1', SHA256 = 'e19d67ccc57145fbeecd3f3958babe9c1578cd0023e8830b391178ee49456a3e';
const REGISTRY = 'https://packages.unity.com/com.unity.ai.assistant';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const sampleCatalog = [{ name: 'Unity_ReadConsole', inputSchema: { type: 'object', properties: { Action: { enum: ['Get', 'Clear'] }, Count: { type: 'integer' } } }, description: 'fixture' },
	{ name: 'Unity_RunCommand', inputSchema: { type: 'object' }, description: 'fixture' }];
async function policyTests() {
	const runtime = require('../../unity-cursor-toolkit/out/mcp/server').createStandaloneMcpRuntime(true);
	const calls = [];
	const upstream = { request: async (method, params) => { calls.push({ method, params }); return { content: [{ type: 'text', text: 'read' }] }; } };
	const module = provider(upstream, sampleCatalog);
	runtime.router.register(module);
	const refused = [];
	for (const [name, args] of [
		['Unity_RunCommand', { Code: 'System.IO.File.WriteAllText("sentinel","changed")' }],
		['Unity_RunCommand', { Code: 'arbitrary C#', dryRun: true }],
		['Unity_ReadConsole', { Action: 'Clear', dryRun: true }],
		['Unity_ReadConsole', { Action: 'get' }],
		['Unity_ReadConsole', { Action: 'Get', action: 'Clear' }],
		['Unity_ReadConsole', {}],
		['Unknown', { Action: 'Get' }]
	]) {
		const result = await runtime.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call',
			params: { name: 'assistantRelay/' + name, arguments: args } });
		assert.equal(result.isError, true); assert.equal(calls.length, 0);
		refused.push({ name, args, result });
	}
	const allowed = await runtime.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call',
		params: { name: 'assistantRelay/Unity_ReadConsole', arguments: { Action: 'Get', Count: 1 } } });
	assert.equal(allowed.isError, false); assert.equal(calls.length, 1);
	assert.equal(JSON.parse(allowed.content[0].text).origin.packageVersion, VERSION);
	assert.throws(() => requireEditorVersion('2019.4.40f1'), error => error.code === 'relay_editor_unsupported');
	requireEditorVersion('6000.3.9f1');
	runtime.dispose();
	const faults = [];
	for (const [kind, executable, args] of [
		['spawn', path.join(os.tmpdir(), 'uct-missing-' + crypto.randomUUID() + '.exe'), []],
		['timeout', process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));']],
		['exit', process.execPath, ['-e', 'process.exit(7)']],
		['empty-catalog', process.execPath, ['-e', 'const r=require("readline").createInterface({input:process.stdin});r.on("line",s=>{const m=JSON.parse(s);if(m.id)console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:m.method==="tools/list"?{tools:[]}: {}}));});r.on("close",()=>process.exit(0));']]
	]) {
		const client = new RelayClient(executable, args, { timeout: 150 });
		try { await client.catalog(); assert.fail('Expected typed child failure.'); }
		catch (error) { assert(['relay_start_failed', 'relay_timeout', 'relay_unexpected_exit', 'relay_empty_catalog'].includes(error.code)); faults.push({ kind, code: error.code }); }
		await client.close();
	}
	const crashScript = 'const r=require("readline").createInterface({input:process.stdin});r.on("line",s=>{const m=JSON.parse(s);if(m.method==="initialize")console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}}));if(m.method==="tools/list"){console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:' + JSON.stringify(sampleCatalog) + '}}));setTimeout(()=>process.exit(9),30);}});';
	const client = new RelayClient(process.execPath, ['-e', crashScript], { timeout: 1000 });
	const catalog = await client.catalog(); await sleep(100);
	const failed = await provider(client, catalog).handleToolCall('assistantRelay/Unity_ReadConsole', { Action: 'Get' });
	assert.equal(JSON.parse(failed.content[0].text).error.code, 'relay_unexpected_exit');
	faults.push({ kind: 'exit-after-ready', code: 'relay_unexpected_exit' });
	await client.close();
	return { refused, allowed, faults, legacyGate: '2019.4 denied before child construction; shipped code unchanged' };
}
async function waitUntil(check, milliseconds, label, processRecord) {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		const value = check(); if (value) return value;
		if (processRecord?.exit) throw new Error(label + ': Editor exited ' + JSON.stringify(processRecord.exit));
		await sleep(100);
	}
	throw new Error(label + ' exceeded ' + milliseconds + 'ms');
}
async function discoveryPreflight() {
	const archive = arg('--archive');
	if (!archive || hash(archive) !== SHA256) throw new Error('Pinned archive required for owned discovery preflight.');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-assistant-relay-'));
	const home = path.join(fixture, 'home'), directory = path.join(home, '.unity', 'mcp', 'connections');
	fs.mkdirSync(directory, { recursive: true });
	const binary = path.join(fixture, 'relay_win.exe');
	const bytes = spawnSync('tar', ['-xOf', archive, 'package/RelayApp~/relay_win.exe'], { maxBuffer: 200 * 1024 * 1024, windowsHide: true });
	if (bytes.status !== 0) throw new Error('Relay extraction failed.');
	fs.writeFileSync(binary, bytes.stdout);
	const marker = 'bridge-owned-discovery-' + crypto.randomUUID() + '.json';
	const pipe = '\\\\.\\pipe\\uct-owned-discovery-' + crypto.randomUUID();
	fs.writeFileSync(path.join(directory, marker), JSON.stringify({ connection_path: pipe, editor_pid: process.pid, project_path: fixture }));
	const client = new RelayClient(binary, ['--mcp', '--project-path', fixture, '--instance-id', String(process.pid)],
		{ cwd: fixture, env: { ...process.env, USERPROFILE: home, UNITY_MCP_DEBUG: 'true' }, timeout: 3000 });
	let error;
	try { await client.catalog(); } catch (caught) { error = { code: caught.code, message: caught.message }; }
	const exit = await client.close();
	const foundOwnedRegistry = client.stderr.includes('Using connection from ' + marker + ': ' + pipe);
	const output = path.join(__dirname, 'results', 'discovery-preflight-' + new Date().toISOString().replace(/[:.]/g, '-'));
	fs.mkdirSync(output, { recursive: true });
	const sanitize = value => { for(const [original,replacement] of [[fixture,'<fixture>'],[os.homedir(),'<home>'],[os.hostname(),'<host-name>']])for(const form of [original,original.replace(/\\/g,'/'),JSON.stringify(original).slice(1,-1)])value=value.split(form).join(replacement);return value.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gim,'<credential line omitted>').split(/\r?\n/).map(line=>/licensing|license|access.token|auth.token|serial.number|machine.?id|session.?id|correlation.?id|bearer|hardware.?id|user.?id|account.?id|^\s*(?:Id|Product|Type|Expiration):/i.test(line)?'<licensing or credential line omitted>':line.trimEnd()).join('\n').trimEnd(); };
	fs.writeFileSync(path.join(output, 'child-stderr.log'), sanitize(client.stderr) + '\n');
	fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify({
		foundOwnedRegistry, marker, pipe, error, exit, childPid: client.child.pid,
		archiveSha256: SHA256, relaySha256: hash(binary), packageVersion: VERSION,
		childUserProfileOnly: true, editorLaunched: false, unityTraffic: false,
		expectedRegistry: '<fixture>/home/.unity/mcp/connections',
		primaryApiEvidence: 'https://bun.com/reference/node/os/homedir'
	}, null, 2) + '\n');
	const resolved = path.resolve(fixture);
	if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('uct-assistant-relay-')) throw new Error('Unexpected disposable target.');
	if (exit.exited) fs.rmSync(resolved, { recursive: true });
	if (!foundOwnedRegistry || !exit.exited) throw new Error('Owned home discovery preflight failed; evidence at ' + output);
	console.log(JSON.stringify({ foundOwnedRegistry, exit, output }));
}

async function main() {
	if(process.argv.includes('--discovery-preflight'))return discoveryPreflight();
	const evidence = process.argv.includes('--policy-tests') ? { passed: true, providerSha256: hash(path.join(__dirname, 'relay-provider.js')), ...await policyTests() } : json(arg('--policy-evidence'));
	const tests = evidence?.policyTests || evidence;
	if (evidence?.passed !== true || tests?.passed !== true || !tests?.faults?.length || tests?.allowed?.isError !== false) throw new Error('--policy-evidence must name the recorded successful policy checks.');
	if(evidence.providerSha256!==hash(path.join(__dirname,'relay-provider.js')))throw new Error('Recorded policy evidence does not match current provider.');
	if (process.argv.includes('--policy-tests')) { const result=evidence;if(arg('--output'))fs.writeFileSync(arg('--output'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2)); return; }
	const editor = arg('--editor'), archive = arg('--archive');
	if (!editor || !archive) throw new Error('--editor and --archive are required.');
	if (hash(archive) !== SHA256) throw new Error('Pinned Assistant archive checksum differs.');
	const response = await fetch(REGISTRY, { redirect: 'error', signal: AbortSignal.timeout(15000) });
	if (!response.ok) throw new Error('Registry HTTP failure: ' + response.status);
	const metadata = await response.json(), candidate = metadata.versions?.[VERSION], published = metadata.time?.[VERSION];
	const publication = Date.parse(published), serverDate = Date.parse(response.headers.get('date'));
	if (metadata.name !== 'com.unity.ai.assistant' || !candidate || candidate.version !== VERSION ||
		!Number.isFinite(publication) || new Date(publication).toISOString() !== published || !Number.isFinite(serverDate) ||
		Math.min(Date.now(), serverDate) - publication < 7 * 86400000 || candidate.unity !== '6000.0' || candidate.unityRelease !== '60f1')
		throw new Error('Registry name, canonical publication, HTTP date, release age or minimum Editor gate failed.');
	const product = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		"(Get-Item -LiteralPath '" + editor.replace(/'/g, "''") + "').VersionInfo.ProductVersion"], { encoding: 'utf8', windowsHide: true });
	if (product.status !== 0 || product.stdout.trim() !== '6000.3.9f1_7a9955a4f2fa') throw new Error('Actual Editor ProductVersion is not reviewed6000.3.9f1 revision.');
	const revision = arg('--revision');
	if (revision !== '6000.3.9f1') throw new Error('Only reviewed6000.3.9f1 proof is authorized.');
	requireEditorVersion(revision);
	const output = path.join(__dirname, 'results', 'assistant-relay-' + new Date().toISOString().replace(/[:.]/g, '-'));
	fs.mkdirSync(output, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-assistant-relay-'));
	const proof = path.join(fixture, 'proof'), pkg = path.join(fixture, 'Packages', 'com.unity.ai.assistant');
	for (const folder of [proof, pkg, path.join(fixture, 'Assets', 'Editor'), path.join(fixture, 'ProjectSettings')]) fs.mkdirSync(folder, { recursive: true });
	const unpack = spawnSync('tar', ['-xf', archive, '--strip-components=1', '-C', pkg], { encoding: 'utf8', windowsHide: true });
	if (unpack.status !== 0) throw new Error('Assistant extraction failed: ' + unpack.stderr);
	const prefix = 'UCT.Assistant.Proof.' + crypto.randomUUID() + '.';
	const env = { ...process.env, UCT_ASSISTANT_PROOF_DIR: proof, UCT_ASSISTANT_RELAY_DIR: path.join(fixture, 'relay'),
		UCT_ASSISTANT_MCP_DIR: path.join(fixture, 'home', '.unity', 'mcp'), UNITY_MCP_STATUS_DIR: path.join(fixture, 'home', '.unity', 'mcp', 'connections') };
	for (const key of ['UCT_ASSISTANT_RELAY_DIR', 'UCT_ASSISTANT_MCP_DIR', 'UNITY_MCP_STATUS_DIR', 'UCT_ASSISTANT_PROOF_DIR'])
		if (!env[key] || !path.isAbsolute(env[key]) || !env[key].startsWith(fixture + path.sep)) throw new Error('Owned absolute isolation path required: ' + key);
	function ownedPrefs(remove) {
		const script = "$key='HKCU:\\Software\\Unity Technologies\\Unity Editor 5.x';$prefix='" + prefix + "';$names=@();if(Test-Path -LiteralPath $key){$names=@((Get-Item -LiteralPath $key).GetValueNames() | Where-Object {$_.StartsWith($prefix,[StringComparison]::Ordinal)})};" + (remove ? "foreach($name in $names){Remove-ItemProperty -LiteralPath $key -Name $name};" : "") + "ConvertTo-Json -InputObject @($names) -Compress";
		const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
		if (result.status !== 0) throw new Error('Owned preference scope check failed: ' + result.stderr);
		return JSON.parse(result.stdout.trim());
	}
	if (ownedPrefs(false).length) throw new Error('Owned preference prefix already exists.');
	const changes = [];
	function replace(relative, symbols) {
		const file = path.join(pkg, relative), original = fs.readFileSync(file, 'utf8');
		let modified = original;
		for (const [symbol, old, replacement] of symbols) {
			if (modified.split(old).length !== 2) throw new Error('Isolation source match differs: ' + symbol);
			modified = modified.replace(old, replacement); changes.push({ relative, symbol, old, replacement });
		}
		fs.writeFileSync(file, modified);
		return { relative, originalSha256: crypto.createHash('sha256').update(original).digest('hex'), modifiedSha256: hash(file) };
	}
	const sourceHashes = [
		replace('Modules/Unity.AI.MCP.Editor/Settings/MCPConstants.cs', [
			['relayBaseDirectoryName', 'public static string relayBaseDirectoryName = ".unity/relay";', 'public static string relayBaseDirectoryName = Environment.GetEnvironmentVariable("UCT_ASSISTANT_RELAY_DIR") ?? throw new InvalidOperationException("Owned relay path required");'],
			['mcpBaseDirectoryName', 'public static string mcpBaseDirectoryName = ".unity/mcp";', 'public static string mcpBaseDirectoryName = Environment.GetEnvironmentVariable("UCT_ASSISTANT_MCP_DIR") ?? throw new InvalidOperationException("Owned MCP path required");'],
			['prefProjectSettings', 'public const string prefProjectSettings = "Unity.AI.MCP.ProjectSettings.v2";', 'public const string prefProjectSettings = "' + prefix + 'MCPSettings";']
		]),
		replace('Editor/Assistant/Relay/RelayPersistenceService.cs', [
			['k_KeyPrefix', 'const string k_KeyPrefix = "Unity.AI.Gateway.Relay.";', 'const string k_KeyPrefix = "' + prefix + 'Relay.";']
		])
	];
	const immutableHashes = ['RelayApp~/relay_win.exe', 'Modules/Unity.AI.MCP.Editor/Tools/ReadConsole.cs', 'Modules/Unity.AI.MCP.Editor/Tools/RunCommand.cs'].map(relative => ({ relative, sha256: hash(path.join(pkg, relative)) }));
	const dependencies = { ...JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).dependencies };
	const builtins = path.join(path.dirname(editor), 'Data', 'Resources', 'PackageManager', 'BuiltInPackages');
	for (const entry of fs.readdirSync(builtins, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('com.unity.modules.')) dependencies[entry.name] = '1.0.0';
	fs.writeFileSync(path.join(fixture, 'Packages', 'manifest.json'), JSON.stringify({ dependencies }, null, 2));
	fs.writeFileSync(path.join(fixture, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + revision + '\n');
	fs.copyFileSync(path.join(__dirname, 'AssistantRelayProbe.cs'), path.join(fixture, 'Assets', 'Editor', 'AssistantRelayProbe.cs'));
	const record = { providerSha256: hash(path.join(__dirname,'relay-provider.js')), packageVersion: VERSION, archiveSha256: SHA256, registry: REGISTRY, published,
		minimumEditorVersion: '6000.0.60f1', editorVersion: revision, productVersion: product.stdout.trim(), serverDate: new Date(serverDate).toISOString(), policyTests: tests, changes, sourceHashes, immutableHashes,
		mcpChildHomeOverride: '<fixture>/home', defaultInstallBehaviorProved: false, coreclrCompatibilityProved: false, paidAiInvocation: false };
	const sanitizers = [[fixture, '<fixture>'], [os.homedir(), '<home>'], [path.dirname(editor), '<editor-directory>']];
	for (const item of Object.values(os.networkInterfaces()).flat()) if (item && !item.internal) sanitizers.push([item.address, '<owned-interface-ip>']);
	sanitizers.push([os.hostname(), '<host-name>'], [path.dirname(path.dirname(path.dirname(editor))), '<unity-launcher>']);
	function sanitize(text) {
		for (const [value, replacement] of sanitizers) for (const form of [value, value.replace(/\\/g, '/'), JSON.stringify(value).slice(1,-1)])
			text = text.split(form).join(replacement);
		return text.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gim, '<credential line omitted>').split(/\r?\n/).map(line => /licensing|license|access.token|auth.token|serial.number|machine.?id|session.?id|correlation.?id|bearer|hardware.?id|user.?id|account.?id|^\s*(?:Id|Product|Type|Expiration):/i.test(line)
			? '<licensing or credential line omitted>' : line.trimEnd()).join('\n').trimEnd();
	}
	function clean(value) { return typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean)
		: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,clean(item)])) : value; }
	function save(name, value) { fs.writeFileSync(path.join(output, name), typeof value === 'string' ? sanitize(value) + '\n' : JSON.stringify(clean(value), null, 2) + '\n'); }
	function ownedProcesses() {
		const escaped = fixture.replace(/'/g, "''");
		const query = "$root='" + escaped + "'; $items=@(Get-CimInstance Win32_Process | Where-Object {($_.Name -eq 'Unity.exe' -or $_.Name -eq 'relay_win.exe') -and (($_.CommandLine -and $_.CommandLine.Contains($root)) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\\')))} | Select-Object ProcessId,Name);ConvertTo-Json -InputObject @($items) -Compress";
		const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',query], { encoding:'utf8', windowsHide:true });
		if(result.status !== 0) throw new Error('Owned process cleanup query failed.');
		return JSON.parse(result.stdout.trim());
	}
	let relay, runtime, owned;
	const started = Date.now();
	try {
		const args = ['-batchmode', '-projectPath', fixture, '-logFile', path.join(proof, 'editor.log')];
		const stdout = fs.openSync(path.join(proof, 'editor.stdout.log'), 'w');
		const child = spawn(editor, args, { env, windowsHide: true, stdio: ['ignore', stdout, stdout] }); fs.closeSync(stdout);
		owned = { child }; child.once('exit', (code, signal) => { owned.exit = { code, signal }; }); child.once('error', error => { owned.exit = { error: error.message }; });
		console.log(JSON.stringify({ editorPid: child.pid, fixture, output }));
		const ready = await waitUntil(() => {
			if (json(path.join(proof, 'bootstrap-error.json'))) throw new Error(JSON.stringify(json(path.join(proof, 'bootstrap-error.json'))));
			if (json(path.join(proof, 'startup-error.json'))) throw new Error(JSON.stringify(json(path.join(proof, 'startup-error.json'))));
			return json(path.join(proof, 'ready.json'));
		}, 180000, 'Assistant fixture readiness', owned);
		const bootstrap=json(path.join(proof,'bootstrap.json'));if(bootstrap?.pid!==child.pid || bootstrap.version!==revision || bootstrap.coreLibrary!=='mscorlib' || bootstrap.isMono!==true)throw new Error('Actual bootstrap PID/version/Mono core library mismatch.'); record.bootstrap=bootstrap;
		record.editorStartupMilliseconds = Date.now() - started; record.editorPid = child.pid; record.relayPid = ready.relayPid;
		const relayStart = Date.now();
		relay = new RelayClient(path.join(fixture, 'relay', 'relay_win.exe'), ['--mcp', '--project-path', fixture, '--instance-id', String(child.pid)],
			{ env: { ...env, USERPROFILE: path.join(fixture, 'home') }, cwd: fixture, timeout: 15000 });
		const catalog = await relay.catalog(); record.childStartupMilliseconds = Date.now() - relayStart; save('relay-catalog.json', catalog);
		runtime = require('../../unity-cursor-toolkit/out/mcp/server').createStandaloneMcpRuntime(true);
		runtime.router.register(provider(relay, catalog, true));
		const before = relay.requests.length;
		record.denied = [];
		for (const arguments of [{ Code: 'System.IO.File.WriteAllText("' + path.join(fixture, 'sentinel').replace(/\\/g, '\\\\') + '","changed")' }, { Code: 'arbitrary C#', dryRun: true }]) {
			const response = await runtime.handleRequest({ id: 40, method: 'tools/call', params: { name: 'assistantRelay/Unity_RunCommand', arguments } });
			assert.equal(response.isError, true); record.denied.push(response);
		}
		assert.equal(relay.requests.length, before); assert(!fs.existsSync(path.join(fixture, 'sentinel')));
		record.deniedRequestsForwarded = 0; record.sentinelCreated = false; record.calls = [];
		for (let i = 0; i < 5; i++) {
			const callStart = Date.now(), response = await runtime.handleRequest({ id: i + 50, method: 'tools/call',
				params: { name: 'assistantRelay/Unity_ReadConsole', arguments: { Action: 'Get', Count: 10, FilterText: 'UCT_ASSISTANT_PROBE_SENTINEL' } } });
			record.calls.push({ milliseconds: Date.now() - callStart, response });
			assert.equal(response.isError, false);
			assert(response.content[0].text.includes('UCT_ASSISTANT_PROBE_SENTINEL'));
		}
		record.passed = true;
	} catch (error) { record.passed = false; record.error = { code: error.code || 'probe_failed', message: error.message }; }
	finally {
		runtime?.dispose();
		if (relay) { record.childExit = await relay.close(); save('child-stderr.log', relay.stderr); save('child-rpc.jsonl', relay.messages.map(message => JSON.stringify(message)).join('\n')); }
		fs.writeFileSync(path.join(proof, 'stop'), '');
		if (owned) {
			try { await waitUntil(() => owned.exit, 30000, 'Owned Editor normal exit'); record.editorExit = owned.exit; }
			catch (error) { record.cleanupError = error.message; }
		}
		for (const name of fs.readdirSync(proof)) if (name !== 'stop') save(name, fs.readFileSync(path.join(proof, name), 'utf8'));
		for (const item of immutableHashes) assert.equal(hash(path.join(pkg, item.relative)), item.sha256);
		record.remainingOwnedProcesses=ownedProcesses();
		record.normalEditorExit = record.editorExit?.code === 0 && fs.existsSync(path.join(proof, 'quitting.json')) && record.remainingOwnedProcesses.length===0 && (!relay || (record.childExit.exited && record.childExit.code === 0 && record.childExit.signal === null));
		if(!record.normalEditorExit){record.passed=false;record.cleanupError=record.cleanupError||'Owned process normal exit or absence not proved.';}
		if (record.normalEditorExit && (!relay || record.childExit.exited)) { record.deletedOwnedPrefs = ownedPrefs(true); assert.equal(ownedPrefs(false).length, 0); }
		save('observation.json', record);
		if (record.normalEditorExit) {const resolved=path.resolve(fixture),temp=path.resolve(os.tmpdir());if(path.dirname(resolved)!==temp||!path.basename(resolved).startsWith('uct-assistant-relay-'))throw new Error('Disposable target outside intended TEMP prefix.');fs.rmSync(resolved,{recursive:true});}
		else console.log('Retained owned fixture for cleanup review: ' + fixture);
		console.log(JSON.stringify({ passed: record.passed, normalEditorExit: record.normalEditorExit, output, error: record.error }));
	}
	if (!record.passed || !record.normalEditorExit) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
