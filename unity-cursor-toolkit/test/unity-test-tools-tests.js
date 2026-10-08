'use strict';
// Exercise the compiled provider at its ICommandSender ownership boundary.
const assert = require('assert');
const path = require('path');
const os = require('os');
const { UnityTestMcpTools } = require('../out/mcp/unityTestTools');
const project = path.join(os.tmpdir(), 'uct-provider-unit-project');
const version = '6000.6.4f1', pid = 414141;
let passed = 0, failed = 0;
async function test(name, run) {
	try { await run(); passed++; console.log('PASS ' + name); }
	catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function snapshot(args, status = 'completed', states = ['passed']) {
	const tests = states.map((state, index) => ({ id: 'test-' + index, fullName: 'Acme.Tests.Case.Test' + index, status: state, durationMs: 2, message: '', stackTrace: '' }));
	const summary = { total: tests.length, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: 2 };
	for (const leaf of tests) summary[leaf.status === 'not_run' ? 'notRun' : leaf.status]++;
	return { success: ['completed', 'listed'].includes(status), backend: 'bridge', runId: args.runId, status, editorPid: pid, editorVersion: version, mode: args.mode,
		selection: tests.map(leaf => leaf.fullName), tests, summary,
		...(['failed', 'cancelled', 'timed_out', 'error'].includes(status) ? { error: { code: status === 'failed' ? 'test_runner_failed' : status, message: 'Owned test outcome.', recovery: 'Inspect the same Editor.' } } : {}) };
}
function fixture(options = {}) {
	const calls = [], cliCalls = [];
	const caps = { success: true, available: true, backend: 'bridge', projectPath: project, editorVersion: version, editorPid: pid, modes: ['EditMode', 'PlayMode'], supportsCancellation: true, ...options.capabilities };
	const cli = {
		async runTests(request) { cliCalls.push({ action: 'run', request }); return options.cliRun ? options.cliRun(request) : { ...snapshot({ runId: 'cli-fixture', mode: request.mode }), backend: 'cli' }; },
		async listTests(request) { cliCalls.push({ action: 'list', request }); return { ...snapshot({ runId: 'cli-fixture', mode: request.mode }, 'error', []), backend: 'cli', error: { code: 'capability_unavailable', message: 'No CLI discovery.', recovery: 'Use bridge.' } }; }
	};
	const sender = { send() { throw new Error('request/response ownership is required'); }, async request(command, payload) {
		assert.strictEqual(command, 'mcpToolCall'); assert.strictEqual(payload.toolName, 'test_runner');
		const args = payload.args; calls.push(args);
		if (args.action === 'capabilities') return options.capabilityReply ? options.capabilityReply(args) : options.absent ? null : { result: caps };
		assert.strictEqual(args.projectPath, project); assert.strictEqual(args.editorPid, pid);
		assert.ok(/^[0-9a-f]{32}$/.test(args.runId)); assert.ok(/^[0-9a-f]{64}$/.test(args.ownerToken));
		if (options.handle) return options.handle(args, calls);
		return { result: args.action === 'list' ? snapshot(args, 'listed', ['not_run']) : snapshot(args) };
	} };
	return { calls, cliCalls, cli, sender, provider: new UnityTestMcpTools(sender, () => project, cli, !!options.readOnly) };
}
const request = { mode: 'EditMode', backend: 'bridge', timeoutMs: 5000 };
function error(result, code) {
	assert.strictEqual(result.success, false); assert.strictEqual(result.error.code, code); assert.ok(result.runId);
}
async function main() {
	await test('read-only execution refuses before capabilities or backend execution', async () => {
		const f = fixture({ readOnly: true }); error(await f.provider.execute('run_tests', request), 'policy_refused'); assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('read-only dry-run and listing only discover with literal filters forwarded', async () => {
		const f = fixture({ readOnly: true }), filter = { assembly: 'Tests.Editor', namespace: 'Acme', class: 'Acme.Tests.Case', test: 'Acme.Tests.Case.Test0', category: 'Fast' };
		for (const [name, args] of [['list_tests', request], ['run_tests', { ...request, dryRun: true, filter }]]) {
			const result = await f.provider.execute(name, args); assert.strictEqual(result.success, true); assert.strictEqual(result.status, 'listed'); assert.strictEqual(result.summary.notRun, 1);
		}
		assert.ok(!f.calls.some(call => call.action === 'run')); assert.deepStrictEqual(f.calls.at(-1).filter, filter); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('explicit CLI bypasses bridge and explicit bridge never falls back when unavailable', async () => {
		const f = fixture({ absent: true }); const cli = await f.provider.execute('run_tests', { ...request, backend: 'cli' });
		assert.strictEqual(cli.backend, 'cli'); assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.cliCalls.length, 1);
		error(await f.provider.execute('run_tests', request), 'capability_unavailable'); assert.strictEqual(f.cliCalls.length, 1);
	});
	await test('auto chooses CLI only before execution when bridge is absent; discovery does not fake a CLI list', async () => {
		const f = fixture({ absent: true }); const result = await f.provider.execute('run_tests', { ...request, backend: 'auto' });
		assert.strictEqual(result.backend, 'cli'); assert.strictEqual(f.cliCalls.length, 1);
		error(await f.provider.execute('list_tests', { ...request, backend: 'auto' }), 'capability_unavailable'); assert.strictEqual(f.cliCalls.length, 1);
	});
	await test('malformed or wrong-target unavailable advertisements cannot select CLI', async () => {
		for (const capabilities of [null, [], 'invalid', {}, { available: false }, { available: false, projectPath: project + '-other', editorPid: pid, editorVersion: version, backend: 'bridge', success: false, modes: ['EditMode'] }]) {
			const f = fixture({ capabilityReply: () => ({ result: capabilities }) });
			error(await f.provider.execute('run_tests', { ...request, backend: 'auto' }), 'capability_unavailable');
			assert.strictEqual(f.cliCalls.length, 0); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities']);
		}
	});
	await test('selected bridge failure never invokes CLI and returns typed failure', async () => {
		const f = fixture({ handle: args => ({ result: snapshot(args, 'failed', ['failed']) }) });
		const result = await f.provider.execute('run_tests', { ...request, backend: 'auto' }); error(result, 'test_runner_failed'); assert.strictEqual(result.status, 'failed'); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('invalid modes, filters, timeout and extra arguments refuse before transport', async () => {
		const f = fixture();
		for (const change of [{ mode: 'Player' }, { backend: 'guess' }, { filter: null }, { filter: { typo: 'x' } }, { filter: { test: '' } }, { filter: { test: 'a\nb' } }, { timeoutMs: 0 }, { timeoutMs: 600001 }, { dryRun: 'true' }, { command: 'quit' }]) error(await f.provider.execute('run_tests', { ...request, ...change }), 'invalid_test_request');
		assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.cliCalls.length, 0);
	});
	for (const [name, capabilities, expected] of [
		['wrong project', { projectPath: project + '-other' }, 'capability_unavailable'],
		['invalid Editor version', { editorVersion: '6000.6' }, 'capability_unavailable'],
		['invalid Editor PID', { editorPid: 0 }, 'capability_unavailable'],
		['wrong available mode', { modes: ['PlayMode'] }, 'capability_unavailable'],
		['malformed availability', { available: 'true' }, 'capability_unavailable'],
		['missing cancellation capability', { supportsCancellation: false }, 'test_cancel_unavailable']
	]) await test(name + ' refuses before start and does not fall back', async () => {
		const f = fixture({ capabilities }); error(await f.provider.execute('run_tests', { ...request, backend: 'auto' }), expected); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities']); assert.strictEqual(f.cliCalls.length, 0);
	});
	const invalidSnapshots = [
		['wrong run ID', value => { value.runId = 'another-run'; }],
		['terminal work still pending', value => { value.workStopped = false; }],
		['wrong PID', value => { value.editorPid = pid + 1; }],
		['wrong exact version', value => { value.editorVersion = '6000.3.9f1'; }],
		['duplicate IDs', value => { value.tests[1].id = value.tests[0].id; }],
		['duplicate full names', value => { value.tests[1].fullName = value.tests[0].fullName; }],
		['duplicate selection', value => { value.selection[1] = value.selection[0]; }],
		['selection mismatch', value => { value.selection[1] = 'Unselected.Case.Test'; }],
		['inconsistent summary', value => { value.summary.passed = 99; }],
		['unknown test state', value => { value.tests[0].status = 'unknown'; }],
		['negative duration', value => { value.tests[0].durationMs = -1; }],
		['oversized UTF-8 result', value => { value.tests[0].message = '\u754c'.repeat(400000); }],
		['empty full name', value => { value.tests[0].fullName = ''; }]
	];
	for (const [name, mutate] of invalidSnapshots) await test(name + ' result is refused and owned run is stopped', async () => {
		const f = fixture({ handle: args => {
			if (args.action === 'cancel') return { result: snapshot(args, 'cancelled', ['not_run']) };
			const value = snapshot(args, 'completed', ['passed', 'passed']); mutate(value); return { result: value };
		} });
		error(await f.provider.execute('run_tests', request), 'invalid_output'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'cancel']); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('malformed or missing terminal error never passes and triggers owned stop', async () => {
		for (const malformed of [undefined, null, 'raw error', {}, { code: 'x', message: 3, recovery: 'retry' }]) {
			const f = fixture({ handle: args => {
				const value = snapshot(args, args.action === 'cancel' ? 'cancelled' : 'failed', [args.action === 'cancel' ? 'not_run' : 'failed']);
				if (args.action !== 'cancel') value.error = malformed;
				return { result: value };
			} });
			error(await f.provider.execute('run_tests', request), 'invalid_output'); assert.strictEqual(f.calls.at(-1).action, 'cancel');
		}
	});
	await test('private bridge text, credentials and owner metadata do not reach public output', async () => {
		const secret = 'PROVIDER_FIXTURE_SECRET_12345', old = process.env.UCT_PROVIDER_SECRET; process.env.UCT_PROVIDER_SECRET = secret;
		const sensitive = 'Bearer private-bearer "password":"private-password" token=private-token ' + secret + ' ' + os.homedir() + ' C:\\Other\\User\\private.txt /home/other/private';
		const f = fixture({ handle: args => {
			const value = snapshot(args, 'failed', ['failed']); value.tests[0].message = sensitive; value.tests[0].stackTrace = sensitive + '\n' + 'frame'.repeat(4000) + 'END_OF_STACK';
			value.error = { code: 'test_runner_failed', message: sensitive, recovery: sensitive }; value.ownerToken = args.ownerToken; value.auth = { token: secret }; return { result: value };
		} });
		try {
			const result = await f.provider.handleToolCall('run_tests', request); const text = result.content[0].text;
			const normalized = JSON.parse(text); error(normalized, 'test_runner_failed'); assert.strictEqual(normalized.tests.length, 1); assert.ok(normalized.tests[0].message.includes('<redacted>')); assert.ok(normalized.tests[0].stackTrace.endsWith('END_OF_STACK'));
			for (const value of [secret, 'private-bearer', 'private-password', 'private-token', os.homedir(), 'C:\\Other', '/home/other', f.calls.find(call => call.action === 'run').ownerToken]) assert.ok(!text.includes(value), 'private value escaped boundary');
			assert.ok(!text.includes('ownerToken')); assert.ok(!text.includes('"auth"'));
		} finally { if (old === undefined) delete process.env.UCT_PROVIDER_SECRET; else process.env.UCT_PROVIDER_SECRET = old; }
	});
	await test('malformed error codes cannot expose secrets and trigger a valid owned stop', async () => {
		for (const code of ['', 'Bearer private-code', 'C:\\Other\\private-code', 'PROVIDER_PRIVATE_CODE']) {
			const f = fixture({ handle: args => {
				const value = snapshot(args, args.action === 'cancel' ? 'cancelled' : 'failed', [args.action === 'cancel' ? 'not_run' : 'failed']);
				if (args.action !== 'cancel') value.error.code = code;
				return { result: value };
			} });
			const result = await f.provider.execute('run_tests', request); error(result, 'invalid_output'); assert.strictEqual(f.calls.at(-1).action, 'cancel');
			if (code) assert.ok(!JSON.stringify(result).includes(code));
		}
	});
	await test('discovery heartbeat and progress preserve owner and final exact selection', async () => {
		const progress = [], f = fixture({ handle: args => ({ result: args.action === 'list' ? snapshot(args, 'discovering', []) : snapshot(args, 'listed', ['not_run']) }) });
		const result = await f.provider.execute('list_tests', request, { reportProgress: (...values) => progress.push(values) });
		assert.strictEqual(result.status, 'listed'); assert.deepStrictEqual(result.selection, ['Acme.Tests.Case.Test0']); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'list', 'status']);
		assert.deepStrictEqual(progress.map(values => values.slice(0, 2)), [[0, 0], [0, 0], [0, 1]]);
		const owner = f.calls.find(call => call.action === 'list'); assert.strictEqual(f.calls.at(-1).runId, owner.runId); assert.strictEqual(f.calls.at(-1).ownerToken, owner.ownerToken);
	});
	await test('backwards progress is refused and owned stop is confirmed', async () => {
		const f = fixture({ handle: args => ({ result: args.action === 'run' ? snapshot(args, 'running', ['passed', 'not_run']) : args.action === 'status' ? snapshot(args, 'running', ['not_run', 'not_run']) : snapshot(args, 'cancelled', ['not_run', 'not_run']) }) });
		error(await f.provider.execute('run_tests', request), 'invalid_output'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'status', 'cancel']);
	});
	await test('zero-test terminal error after progress preserves native error rather than false regression', async () => {
		const f = fixture({ handle: args => ({ result: args.action === 'run' ? snapshot(args, 'running', ['passed', 'not_run']) : snapshot(args, 'error', []) }) });
		const result = await f.provider.execute('run_tests', request); error(result, 'error'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'status']);
	});
	async function bounded(promise) {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request did not settle after its caller deadline')), 500); })]); }
		finally { clearTimeout(timer); }
	}
	await test('deadline interrupts a pending nonmutating capabilities request without starting work', async () => {
		const f = fixture({ capabilityReply: () => new Promise(() => {}) });
		error(await bounded(f.provider.execute('run_tests', { ...request, timeoutMs: 5 })), 'timed_out'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities']); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('deadline interrupts pending owned start and confirms stop using the same identity', async () => {
		const f = fixture({ handle: args => args.action === 'run' ? new Promise(() => {}) : { result: snapshot(args, 'cancelled', ['not_run']) } });
		error(await bounded(f.provider.execute('run_tests', { ...request, timeoutMs: 5 })), 'timed_out'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'cancel']);
	});
	await test('caller abort stops the correlated owned run and returns cancellation', async () => {
		const controller = new AbortController(), f = fixture({ handle: args => { if (args.action === 'run') controller.abort(); return { result: snapshot(args, args.action === 'cancel' ? 'cancelled' : 'running', ['not_run']) }; } });
		const result = await f.provider.execute('run_tests', request, { signal: controller.signal }); error(result, 'cancelled'); assert.strictEqual(result.status, 'cancelled'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'cancel']);
		assert.strictEqual(f.calls[1].ownerToken, f.calls[2].ownerToken); assert.strictEqual(f.calls[1].runId, f.calls[2].runId);
	});
	await test('pre-aborted request performs no backend work', async () => {
		const controller = new AbortController(); controller.abort(); const f = fixture(); error(await f.provider.execute('run_tests', request, { signal: controller.signal }), 'cancelled'); assert.strictEqual(f.calls.length, 0);
	});
	await test('deadline after owned start cancels that run and reports timed_out', async () => {
		const f = fixture({ handle: async args => { if (args.action === 'run') await new Promise(resolve => setTimeout(resolve, 20)); return { result: snapshot(args, args.action === 'cancel' ? 'cancelled' : 'running', ['not_run']) }; } });
		const result = await f.provider.execute('run_tests', { ...request, timeoutMs: 5 }); error(result, 'timed_out'); assert.strictEqual(result.status, 'timed_out'); assert.strictEqual(f.calls.at(-1).action, 'cancel');
	});
	await test('CLI controller deadline becomes timeout instead of caller cancellation', async () => {
		const f = fixture({ cliRun: async req => {
			await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
			return { ...snapshot({ runId: 'cli-fixture', mode: req.mode }, 'cancelled', []), backend: 'cli' };
		} });
		const result = await f.provider.execute('run_tests', { ...request, backend: 'cli', timeoutMs: 5 }); error(result, 'timed_out'); assert.strictEqual(result.status, 'timed_out'); assert.strictEqual(f.calls.length, 0);
	});
	await test('foreign or still-pending cancellation acknowledgement waits for correlated stopped status', async () => {
		for (const mutate of [value => { value.editorPid = pid + 1; }, value => { value.workStopped = false; }]) {
			const controller = new AbortController(), f = fixture({ handle: args => {
				if (args.action === 'run') { controller.abort(); return { result: snapshot(args, 'running', ['not_run']) }; }
				const value = snapshot(args, 'cancelled', ['not_run']); if (args.action === 'cancel') mutate(value); return { result: value };
			} });
			error(await f.provider.execute('run_tests', request, { signal: controller.signal }), 'cancelled'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'cancel', 'status']);
		}
	});
	await test('transport failure after owned start performs best-effort cancellation', async () => {
		const f = fixture({ handle: args => { if (args.action === 'run') throw new Error('private transport detail'); return { result: snapshot(args, 'cancelled', ['not_run']) }; } });
		const result = await f.provider.execute('run_tests', request); error(result, 'test_operation_failed'); assert.strictEqual(f.calls.at(-1).action, 'cancel'); assert.ok(!JSON.stringify(result).includes('private transport detail')); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('unconfirmed owned stop is typed and never selects another backend', async () => {
		const f = fixture({ handle: args => { if (args.action === 'cancel') throw new Error('fixture disconnect'); return { result: {} }; } });
		error(await f.provider.execute('run_tests', request), 'cancellation_unconfirmed'); assert.deepStrictEqual(f.calls.map(call => call.action), ['capabilities', 'run', 'cancel']); assert.strictEqual(f.cliCalls.length, 0);
	});
	await test('one provider rejects concurrent ownership and releases it after completion', async () => {
		let release; const waiting = new Promise(resolve => { release = resolve; });
		const f = fixture({ handle: async args => { if (args.action === 'run') await waiting; return { result: snapshot(args) }; } });
		const first = f.provider.execute('run_tests', request); await new Promise(resolve => setImmediate(resolve));
		error(await f.provider.execute('run_tests', request), 'test_run_active'); release(); assert.strictEqual((await first).success, true); assert.strictEqual((await f.provider.execute('run_tests', request)).success, true);
	});
	console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total'); process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
