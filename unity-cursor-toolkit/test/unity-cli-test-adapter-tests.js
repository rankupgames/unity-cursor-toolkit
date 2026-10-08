'use strict';
// Replay the recorded CLI framing and NUnit reports at the existing spawn boundary.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { UnityCliAdapter } = require('../out/core/unityCliAdapter');
const { UnityCliTestAdapter } = require('../out/core/unityCliTestAdapter');
const captures = path.resolve(__dirname, '../../experiments/unity-cli-baseline/captures');
const prefix = '2026-10-08-cli-1.0.0-beta.12-editor-6000.6.4f1-windows-x64-';
const xml = name => fs.readFileSync(path.join(captures, prefix + name + '.xml'), 'utf8');
const capture = name => JSON.parse(fs.readFileSync(path.join(captures, prefix + name + '.json'), 'utf8'));
const passXml = xml('edit-pass'), failXml = xml('edit-fail');
let passed = 0, failed = 0;
async function test(name, run) {
	try { await run(); passed++; console.log('PASS ' + name); }
	catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-cli-test-adapter-'));
	const project = path.join(root, 'Project with spaces');
	for (const dir of ['Assets', 'ProjectSettings', 'Packages', 'Library/PackageCache']) fs.mkdirSync(path.join(project, dir), { recursive: true });
	fs.writeFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.6.4f1\n');
	const dependencies = { 'com.unity.test-framework': '1.8.0', 'com.unity.ext.nunit': '2.1.0' };
	fs.writeFileSync(path.join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies }));
	fs.writeFileSync(path.join(project, 'Packages/packages-lock.json'), JSON.stringify({ dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [name, { version, source: 'registry', url: 'https://packages.unity.com' }])) }));
	for (const [name, version] of Object.entries(dependencies)) {
		const dir = path.join(project, 'Library/PackageCache', name + '@fixture');
		fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
	}
	const editor = path.join(root, 'Editor', 'Unity.exe');
	fs.mkdirSync(path.dirname(editor)); fs.writeFileSync(editor, '');
	return { root, project, editor, request: { projectPath: project, mode: 'EditMode', timeoutMs: 3000 } };
}
function removeFixture(root) {
	assert.strictEqual(path.dirname(root), os.tmpdir());
	assert.ok(path.basename(root).startsWith('uct-cli-test-adapter-'));
	fs.rmSync(root, { recursive: true, force: true });
}
async function withFixture(run, settings = {}) {
	const fixture = setup();
	const original = { spawn: cp.spawn, execFile: cp.execFile, kill: process.kill };
	const calls = [], killed = [], children = new Map();
	let nextPid = 900000;
	cp.spawn = (binary, args, options) => {
		assert.strictEqual(binary, process.execPath);
		assert.strictEqual(options.shell, false);
		assert.deepStrictEqual(args.slice(1, 6), ['--format', 'json', '--non-interactive', '--no-banner', '--no-log-proxy']);
		calls.push({ args, options });
		const child = new EventEmitter(); child.pid = nextPid++;
		child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
		child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
		children.set(child.pid, child);
		process.nextTick(() => {
			let data, result = { exitCode: 0 };
			if (args[0] === 'version') data = { version: settings.version || '1.0.0-beta.12' };
			else if (args[0] === 'editors') data = settings.inventory === undefined
				? [{ version: '6000.6.4f1', architecture: 'x86_64', location: fixture.editor, modules: '' }] : settings.inventory;
			else {
				assert.strictEqual(args[0], 'test');
				const output = args[args.indexOf('--output') + 1];
				if (settings.onTest) settings.onTest(child);
				if (settings.stall) return;
				if (settings.report !== null) fs.writeFileSync(output, settings.report === undefined ? passXml : settings.report);
				if (settings.native) result = settings.native;
				data = { projectPath: fixture.project, output, reports: { nunit: output, junit: null } };
				if (settings.provenance === false) data.output = path.join(fixture.root, 'unowned.xml');
			}
			const stdout = result.stdout === undefined ? JSON.stringify({ success: true, command: args[0], data, errors: [], warnings: [] }) : result.stdout;
			child.stdout.emit('data', stdout);
			child.stderr.emit('data', settings.stderr || '');
			child.emit('exit', result.exitCode, null); child.emit('close', result.exitCode, null);
		});
		return child;
	};
	const closeOwned = pid => {
		assert.ok(children.has(pid), 'cleanup must target a spawned CLI child');
		killed.push(pid);
		const child = children.get(pid); child.emit('exit', 1, null); child.emit('close', 1, null);
	};
	cp.execFile = (_binary, args, _options, done) => {
		assert.deepStrictEqual(args.slice(2), ['/T', '/F']);
		closeOwned(Number(args[1])); done(null);
	};
	process.kill = (pid, signal) => { assert.ok(pid < 0); if (signal === 'SIGTERM') closeOwned(-pid); return true; };
	try { await run({ ...fixture, calls, killed, adapter: new UnityCliTestAdapter(new UnityCliAdapter(process.execPath)) }); }
	finally { cp.spawn = original.spawn; cp.execFile = original.execFile; process.kill = original.kill; removeFixture(fixture.root); }
}
const code = (result, expected) => { assert.strictEqual(result.success, false); assert.strictEqual(result.error.code, expected); assert.ok(/^cli-[0-9a-f]{32}$/.test(result.runId)); };
async function main() {
	await test('recorded EditMode report normalizes at shell-free exact-version process boundary', () => withFixture(async ({ adapter, request, calls, project, editor }) => {
		const result = await adapter.runTests({ ...request, filters: { test: 'CliEditTests.Passing' } });
		assert.strictEqual(result.success, true); assert.strictEqual(result.status, 'completed'); assert.strictEqual(result.backend, 'cli');
		assert.strictEqual(result.editorVersion, '6000.6.4f1'); assert.strictEqual(result.mode, 'EditMode');
		assert.deepStrictEqual(result.selection, ['CliEditTests.Passing']);
		assert.ok(Math.abs(result.tests[0].durationMs - 15.914) < 1e-9); assert.ok(Math.abs(result.summary.durationMs - 45.5453) < 1e-9);
		assert.deepStrictEqual([result.summary.total, result.summary.passed, result.summary.notRun], [1, 1, 0]);
		const args = calls.at(-1).args;
		for (const [flag, value] of [['--editor-version', '6000.6.4f1'], ['--editor-path', editor], ['--mode', 'EditMode'], ['--report-format', 'nunit']]) assert.strictEqual(args[args.indexOf(flag) + 1], value);
		assert.strictEqual(args[6], project); assert.deepStrictEqual(args.slice(-2), ['--', '-nographics']);
		assert.strictEqual(fs.existsSync(path.dirname(args[args.indexOf('--output') + 1])), false);
	}));
	await test('exact CLI backend selection is reported before test spawn and can be cancelled there', () => withFixture(async ({ adapter, request, calls }) => {
		const controller = new AbortController(); let selected = false;
		const result = await adapter.runTests({ ...request, signal: controller.signal, onSelected: version => {
			assert.strictEqual(version, '6000.6.4f1'); assert.ok(!calls.some(c => c.args[0] === 'test')); selected = true; controller.abort();
		} });
		assert.ok(selected); code(result, 'cancelled'); assert.ok(!calls.some(c => c.args[0] === 'test'));
	}));
	await test('recorded PlayMode result preserves mode', () => withFixture(async ({ adapter, request }) => {
		const result = await adapter.runTests({ ...request, mode: 'PlayMode' }); assert.strictEqual(result.success, true); assert.strictEqual(result.mode, 'PlayMode'); assert.deepStrictEqual(result.selection, ['CliPlayTests.Passing']);
	}, { report: xml('play-pass') }));
	await test('recorded failed native exit retains failure, stack and native code without raw output', () => withFixture(async ({ adapter, request }) => {
		const result = await adapter.runTests(request); code(result, 'tests_failed'); assert.strictEqual(result.status, 'failed');
		assert.strictEqual(result.error.nativeCode, 'TESTS_FAILED'); assert.strictEqual(result.error.exitCode, 8);
		assert.strictEqual(result.tests[0].message, 'CLI_PROOF_EXPECTED_FAILURE'); assert.strictEqual(result.summary.failed, 1);
		assert.ok(!/[A-Za-z]:[\\/]/.test(result.tests[0].stackTrace)); assert.ok(result.tests[0].stackTrace.includes('CliEditTests.DeliberateFailure'));
		assert.ok(!('stdout' in result)); assert.ok(!('outputExcerpt' in result.error));
	}, { report: failXml, native: capture('edit-fail') }));
	await test('only reviewed native codes reach public test errors', async () => {
		const recorded = capture('edit-fail'), envelope = JSON.parse(recorded.stdout);
		for (const [nativeCode, expected] of [['INVALID_COMMAND_ARGS', 'invalid_arguments'], ['TESTS_FAILED', 'tests_failed'], ['TEST_TIMED_OUT', 'timed_out'], ['COMMAND_FAILED', 'operation_failed'], ['PRIVATE_NATIVE_CODE_12345', 'operation_failed']]) {
			await withFixture(async ({ adapter, request }) => {
				const result = await adapter.runTests(request); code(result, expected);
				assert.strictEqual(result.error.nativeCode, nativeCode === 'PRIVATE_NATIVE_CODE_12345' ? undefined : nativeCode);
				assert.ok(!JSON.stringify(result).includes('PRIVATE_NATIVE_CODE_12345'));
			}, { report: failXml, native: { ...recorded, stdout: JSON.stringify({ ...envelope, errors: envelope.errors.map(error => ({ ...error, code: nativeCode })) }) } });
		}
	});
	await test('discovery and dry-run refuse before any CLI spawn', () => withFixture(async ({ adapter, request, calls }) => {
		code(await adapter.listTests(request), 'capability_unavailable'); code(await adapter.runTests({ ...request, dryRun: true }), 'capability_unavailable'); assert.strictEqual(calls.length, 0);
	}));
	await test('invalid and unsupported filters refuse before spawn', () => withFixture(async ({ adapter, request, calls }) => {
		for (const filters of [null, [], 3, { unknown: 'x' }, { test: '' }, { test: 'a\nb' }]) code(await adapter.runTests({ ...request, filters }), 'invalid_test_request');
		for (const filters of [{ assembly: 'Tests' }, { category: 'Fast' }, { test: 'One;Two' }]) code(await adapter.runTests({ ...request, filters }), 'capability_unavailable');
		const invalid = await adapter.runTests({ ...request, mode: 'Player' }); code(invalid, 'invalid_test_request'); assert.strictEqual(invalid.mode, null);
		code(await adapter.listTests({ ...request, mode: 'Player' }), 'invalid_test_request');
		assert.strictEqual(calls.length, 0);
	}));
	await test('literal regex metacharacters are escaped and filters compose as AND', () => withFixture(async ({ adapter, request, calls }) => {
		const fullName = 'Acme.Deep.Case.WithTests.Value(1+2)';
		const report = passXml.replace(/CliEditTests\.Passing/g, fullName).replace(/classname="CliEditTests"/g, 'classname="Acme.Deep.Case.WithTests"');
		const originalWrite = fs.writeFileSync; fs.writeFileSync = (file, value, ...args) => originalWrite(file, path.basename(file) === 'results.xml' ? report : value, ...args);
		try {
			const result = await adapter.runTests({ ...request, filters: { namespace: 'Acme', class: 'Acme.Deep.Case.WithTests', test: fullName } });
			assert.strictEqual(result.success, true);
			const args = calls.at(-1).args, pattern = args[args.indexOf('--filter') + 1], regex = new RegExp(pattern);
			assert.ok(regex.test(fullName)); assert.ok(!regex.test('AcmeXDeepXCaseXWithTests.Value(1112)')); assert.ok(!regex.test('Other.Tests.Value(1+2)'));
		} finally { fs.writeFileSync = originalWrite; }
	}));
	await test('declared version, locked project and missing Assets refuse without CLI spawn', () => withFixture(async ({ adapter, request, project, calls }) => {
		const version = path.join(project, 'ProjectSettings/ProjectVersion.txt');
		fs.writeFileSync(version, 'm_EditorVersion: 6000.6\n'); code(await adapter.runTests(request), 'invalid_project');
		fs.writeFileSync(version, 'm_EditorVersion: 6000.6.4f1\n');
		fs.mkdirSync(path.join(project, 'Temp')); fs.writeFileSync(path.join(project, 'Temp/UnityLockfile'), ''); code(await adapter.runTests(request), 'project_locked');
		fs.unlinkSync(path.join(project, 'Temp/UnityLockfile')); fs.rmdirSync(path.join(project, 'Assets')); code(await adapter.runTests(request), 'invalid_project'); assert.strictEqual(calls.length, 0);
	}));
	for (const [name, inventory, expected] of [
		['missing exact Editor', [{ version: '6000.3.9f1' }], 'missing_editor'],
		['missing inventory', null, 'test_metadata_unavailable'],
		['missing module metadata', [{ version: '6000.6.4f1', architecture: 'x86_64', location: process.execPath }], 'test_metadata_unavailable'],
		['ambiguous exact Editor', [{ version: '6000.6.4f1' }, { version: '6000.6.4f1' }], 'test_metadata_unavailable']
	]) await test(name + ' refuses before test spawn', () => withFixture(async ({ adapter, request, calls }) => { code(await adapter.runTests(request), expected); assert.ok(!calls.some(c => c.args[0] === 'test')); }, { inventory }));
	await test('missing registry/package metadata refuses before tests and leaves package files unchanged', () => withFixture(async ({ adapter, request, project, calls }) => {
		const manifest = path.join(project, 'Packages/manifest.json'), lock = path.join(project, 'Packages/packages-lock.json'), originalManifest = fs.readFileSync(manifest);
		const data = JSON.parse(fs.readFileSync(lock)); delete data.dependencies['com.unity.test-framework'].url; fs.writeFileSync(lock, JSON.stringify(data));
		const originalLock = fs.readFileSync(lock); code(await adapter.runTests(request), 'missing_module');
		assert.deepStrictEqual(fs.readFileSync(manifest), originalManifest); assert.deepStrictEqual(fs.readFileSync(lock), originalLock); assert.ok(!calls.some(c => c.args[0] === 'test'));
	}));
	for (const [name, native, expected] of [
		['recorded argument refusal', capture('test-list'), 'invalid_arguments'],
		['recorded Unity test timeout', capture('test-timeout'), 'timed_out'],
		['recorded framework failure with mixed framing', capture('run-cached-framework-incompatible'), 'invalid_output'],
		['recorded Ctrl+C', { exitCode: 130, stdout: '' }, 'cancelled'],
		['undocumented numeric exit', { ...capture('run-cached-framework-incompatible'), exitCode: 97 }, 'unknown_exit'],
		['mixed framing', { exitCode: 0, stdout: 'progress\n' + capture('edit-pass').stdout }, 'invalid_output']
	]) await test(name + ' remains typed and private', () => withFixture(async ({ adapter, request }) => { const result = await adapter.runTests(request); code(result, expected); assert.deepStrictEqual(result.tests, []); assert.ok(!JSON.stringify(result).includes('stdout')); }, { native }));
	for (const [name, report] of [
		['missing', null], ['empty', ''], ['malformed', '<test-run>'], ['DTD', '<!DOCTYPE test-run [<!ENTITY x SYSTEM "file:///private">]>' + passXml],
		['inconsistent totals', passXml.replace('total="1"', 'total="2"')], ['unknown leaf state', passXml.replace(/result="Passed"/g, 'result="Unknown"')],
		['wrong selected test', passXml.replace(/CliEditTests.Passing/g, 'Other.Passing')],
		['missing duration', passXml.replace(/duration="[^"]+"/g, '')], ['native/pass mismatch', failXml]
	]) await test(name + ' report never becomes partial success', () => withFixture(async ({ adapter, request }) => { const result = await adapter.runTests({ ...request, filters: { test: 'CliEditTests.Passing' } }); code(result, 'invalid_results'); assert.strictEqual(result.tests.length, 0); assert.strictEqual(result.summary.total, 0); }, { report }));
	for (const [name, status, counter, errorCode] of [['skipped-mapping', 'completed', 'skipped', undefined], ['inconclusive-mapping', 'failed', 'inconclusive', 'tests_failed']]) {
		const directory = path.join(captures, 'test-backend-parity-2026-10-08T08-22-20-347Z');
		const recorded = JSON.parse(fs.readFileSync(path.join(directory, name + '-native.json'), 'utf8'));
		await test('recorded CLI ' + name + ' preserves leaf counts and native outcome', () => withFixture(async ({ adapter, request }) => {
			const result = await adapter.runTests(request); assert.strictEqual(result.status, status); assert.strictEqual(result.summary[counter], 1);
			assert.strictEqual(result.tests[0].status, counter); assert.ok(result.tests[0].message.startsWith('UCT_EXPECTED_'));
			if (errorCode) { code(result, errorCode); assert.strictEqual(result.error.nativeCode, 'TESTS_FAILED'); assert.strictEqual(result.error.exitCode, 8); }
			else assert.strictEqual(result.success, true);
		}, { report: fs.readFileSync(path.join(directory, name + '.xml'), 'utf8'), ...(recorded.ok ? {} : { native: { exitCode: recorded.exitCode, stdout: JSON.stringify(recorded.stdout) } }) }));
	}
	await test('valid zero-test report returns actionable no_tests instead of an empty pass or malformed report', () => withFixture(async ({adapter,request}) => { code(await adapter.runTests(request), 'no_tests'); }, {report:'<test-run total="0" passed="0" failed="0" skipped="0" inconclusive="0" duration="0" result="Passed" />'}));
	await test('success provenance cannot redirect report to an unrelated path', () => withFixture(async ({ adapter, request }) => { code(await adapter.runTests(request), 'invalid_results'); }, { provenance: false }));
	await test('cancelled NUnit leaves map to not_run and preserve summary total', () => withFixture(async ({ adapter, request }) => {
		const result = await adapter.runTests(request); code(result, 'cancelled'); assert.strictEqual(result.status, 'cancelled'); assert.strictEqual(result.tests[0].status, 'not_run'); assert.strictEqual(result.summary.notRun, 1); assert.strictEqual(result.summary.total, 1);
	}, { report: passXml.replace(/result="Passed"/g, 'result="Cancelled"').replace('passed="1"', 'passed="0"').replace('total="1"', 'total="1" not-run="1"') }));
	await test('failure message redacts credentials, home and arbitrary absolute paths', () => withFixture(async ({ adapter, request, project }) => {
		const privateValue = 'fixture-credential-12345', previous = process.env.UCT_TEST_SECRET; process.env.UCT_TEST_SECRET = privateValue;
		const report = failXml.replace('CLI_PROOF_EXPECTED_FAILURE', 'Bearer private-value token=hidden-one "password":"hidden-two" ' + privateValue + ' ' + os.homedir() + ' C:\\Other\\User\\private.txt /home/other/private');
		const originalWrite = fs.writeFileSync; fs.writeFileSync = (file, value, ...args) => originalWrite(file, path.basename(file) === 'results.xml' ? report : value, ...args);
		try {
			const result = await adapter.runTests(request); code(result, 'tests_failed');
			for (const value of ['private-value', 'hidden-one', 'hidden-two', privateValue, os.homedir(), project, 'C:\\Other', '/home/other']) assert.ok(!JSON.stringify(result).includes(value), value);
		} finally { fs.writeFileSync = originalWrite; if (previous === undefined) delete process.env.UCT_TEST_SECRET; else process.env.UCT_TEST_SECRET = previous; }
	}, { report: failXml, native: capture('edit-fail') }));
	await test('caller cancellation terminates only the owned CLI child', () => withFixture(async ({ adapter, request, killed }) => {
		const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
		try { const result = await adapter.runTests({ ...request, signal: controller.signal }); code(result, 'cancelled'); assert.strictEqual(result.status, 'cancelled'); assert.strictEqual(killed.length, 1); }
		finally { clearTimeout(timer); }
	}, { stall: true }));
	await test('overall deadline terminates only the owned CLI child', () => withFixture(async ({ adapter, request, killed }) => {
		const result = await adapter.runTests({ ...request, timeoutMs: 50 }); code(result, 'timed_out'); assert.strictEqual(killed.length, 1);
	}, { stall: true }));
	await test('pinned CLI mismatch refuses before Editor inventory or tests', () => withFixture(async ({ adapter, request, calls }) => { code(await adapter.runTests(request), 'version_mismatch'); assert.strictEqual(calls.length, 1); }, { version: '1.0.0-beta.13' }));
	console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
	process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
