// Private RUG-526 experiment. No toolkit adapter or user project is loaded.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const VERSION = '3.2.0-1092';
const SHA256 = '3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
async function until(probe, milliseconds, label) {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) { const result = probe(); if (result) return result; await sleep(50); }
	throw new Error(label + ' timed out after ' + milliseconds + 'ms.');
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } }
function launch(executable, args, env, cwd, logFile) {
	const output = fs.openSync(logFile, 'a');
	const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', output, output] });
	fs.closeSync(output);
	const record = { child, command: { executable, args, cwd }, exited: false };
	child.once('error', error => { record.error = error.message; record.exited = true; });
	child.once('exit', (code, signal) => { record.exited = true; record.code = code; record.signal = signal; });
	return record;
}
class Dap {
	constructor(executable, cwd, engineLog) {
		this.deadline = Date.now() + 90000;
		this.messages = []; this.pending = new Map(); this.seq = 0; this.buffer = Buffer.alloc(0); this.stderr = '';
		this.child = spawn(executable, ['--interpreter=vscode', '--engineLogging=' + engineLog],
			{ cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdin.on('error', error => this.finish(error.message));
		this.child.stderr.on('data', data => { this.stderr += data.toString(); });
		this.child.stdout.on('data', data => this.receive(data));
		this.child.once('error', error => this.finish(error.message));
		this.child.once('exit', (code, signal) => { this.exit = { code, signal }; this.finish('Debugger exited.'); });
	}
	finish(message) {
		for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
		this.pending.clear();
	}
	receive(data) {
		this.buffer = Buffer.concat([this.buffer, data]);
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
			if (!match) { this.finish('Invalid DAP header.'); return; }
			const length = Number(match[1]);
			if (this.buffer.length < headerEnd + 4 + length) return;
			let message;
			try { message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()); }
			catch (error) { this.finish('Invalid DAP JSON: ' + error.message); return; }
			this.buffer = this.buffer.subarray(headerEnd + 4 + length);
			this.messages.push({ at: new Date().toISOString(), direction: 'receive', message });
			if (message.type === 'response') {
				const pending = this.pending.get(message.request_seq);
				if (pending) {
					this.pending.delete(message.request_seq); clearTimeout(pending.timer);
					if (message.success) pending.resolve(message); else pending.reject(new Error(message.command + ': ' + message.message));
				}
			}
		}
	}
	request(command, args = {}, milliseconds = 10000) {
		milliseconds = Math.min(milliseconds, this.deadline - Date.now());
		if (milliseconds <= 0) return Promise.reject(new Error('DAP execution exceeded its 90-second deadline.'));
		const message = { seq: ++this.seq, type: 'request', command, arguments: args };
		this.messages.push({ at: new Date().toISOString(), direction: 'send', message });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(message.seq); reject(new Error(command + ' response timed out.')); }, milliseconds);
			this.pending.set(message.seq, { resolve, reject, timer });
			const body = Buffer.from(JSON.stringify(message));
			this.child.stdin.write('Content-Length: ' + body.length + '\r\n\r\n');
			this.child.stdin.write(body);
		});
	}
	event(name, after, predicate = () => true, timeout = 10000) {
		return until(() => this.messages.slice(after).find(item => item.direction === 'receive'
			&& item.message.type === 'event' && item.message.event === name && predicate(item.message.body))?.message, Math.min(timeout, this.deadline - Date.now()), name);
	}
	async frame(threadId) {
		const response = await this.request('stackTrace', { threadId, startFrame: 0, levels: 10 });
		const frame = response.body.stackFrames[0];
		if (!frame) throw new Error('Stopped thread has no managed frame.');
		return frame;
	}
	async locals(frameId) {
		const response = await this.request('scopes', { frameId });
		const values = [];
		for (const scope of response.body.scopes) {
			if (!scope.expensive) {
				const variables = await this.request('variables', { variablesReference: scope.variablesReference });
				values.push(...variables.body.variables);
			}
		}
		return values;
	}
	async step(command, threadId) {
		const after = this.messages.length;
		await this.request(command, { threadId });
		const stopped = await this.event('stopped', after, body => body.reason === 'step');
		return this.frame(stopped.body.threadId);
	}
}
async function attempt(mode, executable, args, fixture, debuggerPath, results) {
	const evidence = path.join(fixture, mode + '.state.json');
	const logFile = path.join(fixture, mode + '.log');
	const commandLog = path.join(fixture, mode + '.stdout.log');
	const target = launch(executable, args.concat(['-logFile', logFile]),
		{ ...process.env, UCT_DEBUG_EVIDENCE: evidence }, fixture, commandLog);
	results.push({ mode, pid: target.child.pid, command: target.command, tests: { attach: false, breakpoint: false, stepOver: false, stepIn: false, stepOut: false, locals: false, detach: false } });
	const result = results[results.length - 1];
	console.log(JSON.stringify({ mode, pid: target.child.pid, fixture }));
	let dap;
	try {
		result.runtime = await until(() => {
			if (target.exited) throw new Error('Target exited before fixture startup: ' + target.code + ' ' + target.error);
			return readJson(evidence);
		}, 180000, mode + ' startup');
		if (result.runtime.pid !== target.child.pid || !result.runtime.coreLibrary.startsWith('System.Private.CoreLib,')
			|| result.runtime.version !== argument('--version') || result.runtime.architecture !== 'x64') {
			throw new Error('Target runtime identity does not match the selected CoreCLR x64 Editor/player.');
		}
		dap = new Dap(debuggerPath, fixture, path.join(fixture, mode + '.engine.log'));
		result.debuggerCommand = { executable: debuggerPath, args: ['--interpreter=vscode', '--engineLogging=<engine.log>'], transport: 'stdio', tcpPorts: [] };
		const beforeInitialize = dap.messages.length;
		await dap.request('initialize', { adapterID: 'uct-private-proof', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
		await dap.event('initialized', beforeInitialize);
		const attached = dap.request('attach', { processId: target.child.pid }, 30000).then(response => ({ response }), error => ({ error }));
		const sourcePath = path.join(fixture, 'Assets/ProbeTarget.cs');
		const breakpointLine = fs.readFileSync(sourcePath, 'utf8').split('\n').findIndex(line => line.includes('PROBE_BREAKPOINT')) + 1;
		const breakpoints = await dap.request('setBreakpoints', { source: { path: sourcePath }, breakpoints: [{ line: breakpointLine }] });
		result.breakpointResponse = breakpoints.body;
		await dap.request('configurationDone');
		const attachOutcome = await attached;
		if (attachOutcome.error) throw attachOutcome.error;
		result.tests.attach = true;
		const triggerAt = dap.messages.length;
		fs.writeFileSync(evidence + '.trigger', 'invoke fixture arithmetic');
		const stopped = await dap.event('stopped', triggerAt, body => body.reason === 'breakpoint');
		const threadId = stopped.body.threadId;
		result.breakpointFrame = await dap.frame(threadId);
		result.breakpointLocals = await dap.locals(result.breakpointFrame.id);
		result.tests.breakpoint = result.breakpointFrame.name.includes('Exercise') && result.breakpointFrame.line === breakpointLine;
		result.tests.locals = result.breakpointLocals.some(value => value.name === 'seed' && value.value === '7');
		result.stepOverFrame = await dap.step('next', threadId);
		result.stepOverLocals = await dap.locals(result.stepOverFrame.id);
		result.tests.stepOver = result.stepOverFrame.name.includes('Exercise')
			&& result.stepOverFrame.line > result.breakpointFrame.line
			&& result.stepOverLocals.some(value => value.name === 'value' && value.value === '10');
		result.callFrame = await dap.step('next', threadId);
		result.stepInFrame = await dap.step('stepIn', threadId);
		result.stepInLocals = await dap.locals(result.stepInFrame.id);
		result.tests.stepIn = result.stepInFrame.name.includes('.Add(')
			&& result.stepInLocals.some(value => value.name === 'input' && value.value === '20');
		result.stepOutFrame = await dap.step('stepOut', threadId);
		result.tests.stepOut = result.stepOutFrame.name.includes('Exercise');
		await dap.request('continue', { threadId });
		await until(() => readJson(evidence)?.phase === 'arithmeticComplete', 10000, 'arithmetic completion');
		const heartbeat = readJson(evidence).heartbeats;
		await dap.request('disconnect', { terminateDebuggee: false });
		result.detachedState = await until(() => {
			const state = readJson(evidence);
			return state && !state.debuggerAttached && state.heartbeats > heartbeat && state.result === 25 ? state : false;
		}, 10000, 'detach heartbeat');
		result.tests.detach = true;
	} catch (error) {
		result.failure = error.message;
	} finally {
		if (dap) {
			if (!result.tests.detach && !dap.exit) {
				dap.deadline = Date.now() + 10000; // Separate bounded detach cleanup after a failed execution deadline.
				try { await dap.request('disconnect', { terminateDebuggee: false }, 10000); result.cleanupDisconnectAccepted = true; }
				catch (error) { result.detachCleanupFailure = error.message; }
			}
			dap.child.stdin.end();
			try { await until(() => dap.exit, 5000, 'debugger exit'); } catch (error) { result.debuggerExitFailure = error.message; dap.child.unref(); }
			result.debuggerExit = dap.exit;
			result.dap = dap.messages;
			result.debuggerStderr = dap.stderr;
		}
		fs.writeFileSync(evidence + '.stop', 'normal owned fixture exit requested');
		try { await until(() => target.exited, 15000, 'target normal exit'); }
		catch (error) { result.exitFailure = error.message; target.child.unref(); }
		result.exit = { code: target.code, hexadecimal: Number.isInteger(target.code) ? '0x' + target.code.toString(16).toUpperCase() : null,
			signal: target.signal, exited: target.exited,
			normalExit: target.exited && target.signal === null && Number.isInteger(target.code) && target.code >= 0 && target.code <= 255 };
		result.behaviorEvidence = Object.fromEntries(Object.entries(result.tests).map(([name, passed]) =>
			[name, { passed, observation: passed ? 'Observed in raw DAP and fixture state.' : 'Not observed: ' + (result.failure || 'required source frame/primitive value/target heartbeat missing') }]));
		result.finalState = readJson(evidence);
		result.passed = ['attach', 'breakpoint', 'stepOver', 'stepIn', 'stepOut', 'locals', 'detach'].every(name => result.tests[name] === true)
			&& target.exited && target.code === 0 && target.signal === null && dap?.exit?.code === 0;
	}
	return target.exited && (!dap || !!dap.exit);
}
async function main() {
	const unity = argument('--unity'), version = argument('--version'), debugRoot = argument('--debugger-root');
	if (!unity || !fs.existsSync(unity) || version !== '7000.0.0a7' || !debugRoot) {
		throw new Error('Pass --unity <installed executable> --version <7000.x version> --debugger-root <verified archive and extracted directory>.');
	}
	const metadata = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		'(Get-Item -LiteralPath $env:UCT_DEBUG_UNITY_EXE).VersionInfo.ProductVersion'],
		{ env: { ...process.env, UCT_DEBUG_UNITY_EXE: unity }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
	const productVersion = metadata.stdout?.trim();
	if (metadata.status !== 0 || productVersion !== version + '_581996e1a8f7' || os.arch() !== 'x64') {
		throw new Error('Exact reviewed Unity revision or Windows x64 host identity does not match.');
	}
	const archive = path.join(debugRoot, 'netcoredbg-win64.zip');
	if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== SHA256) throw new Error('Pinned archive checksum mismatch.');
	const debuggerPath = path.join(debugRoot, 'unpacked/netcoredbg/netcoredbg.exe');
	if (!fs.existsSync(debuggerPath) || !fs.readFileSync(path.join(debugRoot, 'LICENSE'), 'utf8').includes('MIT License')) {
		throw new Error('Verified debugger or retained MIT notice missing.');
	}
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-coreclr-debug-'));
	const results = []; const processes = []; let cleanupAllowed = true;
	const buildLog = path.join(fixture, 'build.log'), buildResultPath = path.join(fixture, 'build.json');
	const observation = { observedAt: new Date().toISOString(), version, productVersion,
		acquisition: 'Existing Unity Launcher installation; no Unity download by this experiment.', revision: '581996e1a8f7',
		os: os.type() + ' ' + os.release(), arch: os.arch(), debugger: { release: VERSION, source: '9744e1f051866215611b8440c638042aa2aa2f72', sha256: SHA256 },
		environment: Object.fromEntries(['DOTNET_EnableDiagnostics', 'COMPlus_EnableDiagnostics', 'DOTNET_EnableDiagnostics_Debugger', 'COMPlus_EnableDiagnostics_Debugger']
			.map(name => [name, process.env[name] ?? null])), overrides: ['UCT_DEBUG_EVIDENCE', 'UCT_DEBUG_BUILD_RESULT'],
		shipsDebugging: false, attempts: results };
	try {
		fs.mkdirSync(path.join(fixture, 'Assets/Editor'), { recursive: true });
		fs.mkdirSync(path.join(fixture, 'Packages')); fs.mkdirSync(path.join(fixture, 'ProjectSettings'));
		fs.writeFileSync(path.join(fixture, 'Packages/manifest.json'), '{"dependencies":{}}');
		fs.writeFileSync(path.join(fixture, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
		fs.copyFileSync(path.join(__dirname, 'ProbeTarget.cs'), path.join(fixture, 'Assets/ProbeTarget.cs'));
		fs.writeFileSync(path.join(fixture, 'Assets/EditorProbe.cs'), '#if UNITY_EDITOR\n' + fs.readFileSync(path.join(__dirname, 'EditorProbe.cs'), 'utf8') + '\n#endif\n');
		cleanupAllowed = await attempt('editor', unity, ['-batchmode', '-nographics', '-debugCodeOptimization', '-projectPath', fixture,
			'-executeMethod', 'UCTDebugProbe.EditorProbe.Run'], fixture, debuggerPath, results);
		if (!cleanupAllowed) throw new Error('Owned Editor still running; no player build launched.');
		const build = launch(unity, ['-batchmode', '-nographics', '-debugCodeOptimization', '-buildTarget', 'Win64', '-projectPath', fixture,
			'-executeMethod', 'UCTDebugProbe.EditorProbe.BuildPlayer', '-logFile', buildLog], { ...process.env, UCT_DEBUG_BUILD_RESULT: buildResultPath }, fixture, path.join(fixture, 'build.stdout.log'));
		processes.push(build); console.log(JSON.stringify({ mode: 'build', pid: build.child.pid, fixture }));
		await until(() => build.exited, 180000, 'player build');
		observation.build = { command: build.command, code: build.code, signal: build.signal, result: readJson(buildResultPath) };
		if (build.code !== 0 || observation.build.result?.result !== 'Succeeded' || observation.build.result.backend !== 'CoreCLR') {
			throw new Error('CoreCLR player build failed; no player attach attempted.');
		}
		cleanupAllowed = await attempt('player', path.join(fixture, 'Build/Probe.exe'), ['-batchmode', '-nographics'], fixture, debuggerPath, results);
	} catch (error) {
		observation.failure = error.message;
	} finally {
		cleanupAllowed = cleanupAllowed && processes.every(item => item.exited);
		const sanitize = value => {
			for (const [location, label] of [[fixture, '<disposable-project>'], [debugRoot, '<debugger-root>'], [unity, '<unity-executable>'],
				[path.dirname(unity), '<unity-install>'], [os.homedir(), '<user-home>'], [os.hostname(), '<host-name>'],
				...Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal).map(item => [item.address, '<local-ip>'])]) {
				value = value.split(location).join(label).split(location.split(path.sep).join('/')).join(label);
			}
			return value.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gim, '<credential line omitted>')
				.split(/\r?\n/).map(line => /licensing|license|access.token|auth.token|serial.number|machine.?id|session.?id|correlation.?id|bearer|hardware.?id|user.?id|account.?id|^\s*(?:Id|Product|Type|Expiration):/i.test(line)
				? '<credential or licensing line omitted>' : line.trimEnd()).join('\n');
		};
		const clean = value => typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean)
			: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
		observation.passed = results.length === 2 && results.every(result => result.passed) && cleanupAllowed;
		observation.recommendation = observation.passed ? 'proceed: controlled Editor/player feasibility observed; this ships nothing and grants no permission to ship.'
			: 'stop: required Editor/player debugger behavior remains unproved; see observed failures. This ships nothing and grants no permission to ship.';
		const output = path.join(__dirname, 'results', 'unity7-netcoredbg-' + observation.observedAt.replace(/[:.]/g, '-'));
		fs.mkdirSync(output, { recursive: true });
		fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(clean(observation), null, 2) + '\n');
		for (const mode of ['editor', 'player']) {
			const attemptResult = results.find(item => item.mode === mode);
			if (attemptResult?.dap) fs.writeFileSync(path.join(output, mode + '.dap.jsonl'), attemptResult.dap.map(item => JSON.stringify(clean(item))).join('\n') + '\n');
		}
		for (const file of fs.readdirSync(fixture).filter(name => /\.(log|json)$/.test(name))) {
			if (file.endsWith('.state.json')) continue;
			fs.writeFileSync(path.join(output, file), sanitize(fs.readFileSync(path.join(fixture, file), 'utf8')));
		}
		console.log(JSON.stringify({ output, passed: observation.passed, recommendation: observation.recommendation, cleanupAllowed }));
		if (cleanupAllowed) {
			const resolved = path.resolve(fixture);
			if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uct-coreclr-debug-')) {
				throw new Error('Fixture cleanup escaped its temporary root.');
			}
			try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
			catch (error) { console.error('Owned fixture cleanup pending: ' + fixture + ': ' + error.message); }
		} else console.error('Owned fixture remains live; no forced termination: ' + fixture);
		if (!observation.passed) process.exitCode = 1;
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
