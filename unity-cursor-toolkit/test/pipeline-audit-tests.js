'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { PipelineAudit, PipelineAuditError, normalizePipelineNativeCode } = require('../out/core/pipelineAudit');
const CAP = 5 * 1024 * 1024;
const entry = { action: 'list', command: 'get_status', classification: 'read_only' };
const completion = { value: 'result', outcome: 'success' };
let passed = 0, failed = 0;
async function test(name, run) {
	try { await run(); passed++; console.log('PASS ' + name); }
	catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-pipeline-audit-'));
	const file = path.join(root, 'audit.jsonl');
	return { root, file, audit: new PipelineAudit(file, ['get_status']), clean() {
		assert.strictEqual(path.dirname(root), os.tmpdir());
		assert(path.basename(root).startsWith('uct-pipeline-audit-'));
		fs.rmSync(root, { recursive: true, force: true });
	} };
}
function records(file) { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)); }
async function refused(audit, code, callback = () => { throw new Error('Backend must not run'); }) {
	await assert.rejects(audit.withInvocation(entry, callback), error => {
		assert(error instanceof PipelineAuditError);
		assert.strictEqual(error.code, code);
		assert(!error.message.includes(os.tmpdir()));
		return true;
	});
}
async function seeded(f) {
	await f.audit.withInvocation(entry, async () => completion);
	return fs.readFileSync(f.file);
}

(async () => {
	await test('missing and invalid configuration refuses before callback without creating parents', async () => {
		const f = fixture();
		try {
			const windowsInvalid = process.platform === 'win32' ? ['\\server\share\audit.jsonl', '\\?\C:\audit.jsonl',
				'\\.\C:\audit.jsonl', 'C:\parent:stream\audit.jsonl', 'C:\audit:stream.jsonl', '\rooted\audit.jsonl'] : [];
			for (const [file, code] of [[undefined, 'audit_unconfigured'], ['', 'audit_unconfigured'], ['relative.jsonl', 'audit_invalid'],
				[path.join(f.root, 'wrong.txt'), 'audit_invalid'], [path.join(f.root, 'missing', 'audit.jsonl'), 'audit_unavailable'],
				...windowsInvalid.map(file => [file, 'audit_invalid'])]) {
				await refused(new PipelineAudit(file), code);
			}
			if (process.platform === 'win32') {
				const realpath = fs.promises.realpath;
				try {
					for (const canonical of ['\\server\share', '\\?\C:\local', 'C:\parent:stream']) {
						fs.promises.realpath = async () => canonical;
						await refused(f.audit, 'audit_invalid');
					}
				} finally { fs.promises.realpath = realpath; }
			}
			assert.deepStrictEqual(fs.readdirSync(f.root), []);
		} finally { f.clean(); }
	});
	await test('durable start precedes callback and durable terminal precedes returned value', async () => {
		const f = fixture();
		try {
			const value = await f.audit.withInvocation(entry, async () => {
				const start = records(f.file);
				assert.strictEqual(start.length, 1); assert.strictEqual(start[0].outcome, 'started');
				assert(fs.existsSync(f.file + '.lock'));
				return { ...completion, classification: 'destructive', editorVersion: '7000.0.0a7', editorPid: 42, code: 'policy_refused', outcome: 'refused' };
			});
			assert.strictEqual(value, 'result');
			const [start, terminal] = records(f.file);
			assert.strictEqual(start.invocationId, terminal.invocationId);
			assert.strictEqual(terminal.classification, 'destructive'); assert.strictEqual(terminal.editorPid, 42);
			assert.strictEqual(terminal.outcome, 'refused'); assert.strictEqual(terminal.code, 'policy_refused');
			assert.deepStrictEqual(fs.readdirSync(f.root), ['audit.jsonl']);
		} finally { f.clean(); }
	});
	await test('backend exception writes generic failure and preserves original exception without secret text', async () => {
		const f = fixture(), secret = 'credential-secret-host-path';
		const thrown = Object.assign(new Error(secret), { code: 'EIO' });
		try {
			await assert.rejects(f.audit.withInvocation(entry, async () => { throw thrown; }), error => error === thrown);
			const terminal = records(f.file)[1];
			assert.strictEqual(terminal.outcome, 'failure'); assert.strictEqual(terminal.code, 'backend_error');
			assert(!fs.readFileSync(f.file, 'utf8').includes(secret));
			assert(!fs.existsSync(f.file + '.lock'));
		} finally { f.clean(); }
	});
	await test('untrusted fields are redacted and results, arguments, paths and messages are excluded', async () => {
		const f = fixture(), secret = 'valid_looking_secret';
		try {
			await f.audit.withInvocation({ ...entry, command: secret, classification: secret, editorVersion: secret, editorPid: -1,
				args: [secret], host: secret, path: secret }, async () => ({ value: { password: secret }, outcome: 'failure',
				code: secret, nativeCode: secret, exitCode: Infinity, editorVersion: secret, editorPid: 1.5, message: secret }));
			const text = fs.readFileSync(f.file, 'utf8'), rows = records(f.file);
			assert(!text.includes(secret));
			for (const row of rows) {
				assert.strictEqual(row.command, 'unknown'); assert.strictEqual(row.classification, 'unknown');
				assert.deepStrictEqual(Object.keys(row).sort(), ['action', 'classification', 'code', 'command', 'invocationId',
					...(row.outcome === 'failure' ? ['nativeCode'] : []), 'origin', 'outcome', 'time'].sort());
			}
			assert.strictEqual(rows[1].nativeCode, 'unknown'); assert.strictEqual(rows[1].code, 'unknown');
		} finally { f.clean(); }
	});
	await test('known native code and signed exit code are retained without raw native messages', async () => {
		const f = fixture();
		try {
			assert.strictEqual(normalizePipelineNativeCode(undefined), undefined);
			for (const value of ['API_TOKEN_SECRET', null, ['COMMAND_FAILED'], 1]) { assert.strictEqual(normalizePipelineNativeCode(value), 'unknown'); }
			for (const nativeCode of ['COMMAND_FAILED', 'STATUS_NO_INSTANCES', 'STATUS_PIPELINE_LOAD_PENDING']) {
				await f.audit.withInvocation(entry, async () => ({ value: null, outcome: 'failure', code: 'operation_failed', nativeCode, exitCode: 3 }));
				const terminal = records(f.file).at(-1);
				assert.strictEqual(terminal.nativeCode, nativeCode); assert.strictEqual(terminal.exitCode, 3);
			}
		} finally { f.clean(); }
	});
	await test('existing own records remain byte-for-byte and are appended without rotation', async () => {
		const f = fixture();
		try {
			const original = await seeded(f);
			await f.audit.withInvocation({ ...entry, action: 'plan' }, async () => completion);
			const current = fs.readFileSync(f.file);
			assert(current.subarray(0, original.length).equals(original)); assert.strictEqual(records(f.file).length, 4);
			assert.deepStrictEqual(fs.readdirSync(f.root), ['audit.jsonl']);
		} finally { f.clean(); }
	});
	await test('unrelated, partial, extra-field and duplicate-key JSONL refuse without changing records', async () => {
		const f = fixture();
		try {
			const original = await seeded(f), row = records(f.file)[0];
			for (const invalid of [Buffer.from('{"unrelated":true}\n'), original.subarray(0, original.length - 1),
				Buffer.from(JSON.stringify({ ...row, args: ['secret'] }) + '\n'),
				Buffer.from(JSON.stringify(row).replace('{', '{"origin":"unrelated",') + '\n'),
				...['invocationId', 'action', 'command', 'classification', 'outcome', 'code'].map(key => Buffer.from(JSON.stringify({ ...row, [key]: [row[key]] }) + '\n')),
				Buffer.from(JSON.stringify({ ...row, nativeCode: ['COMMAND_FAILED'] }) + '\n')]) {
				fs.writeFileSync(f.file, invalid);
				await refused(f.audit, 'audit_invalid'); assert(fs.readFileSync(f.file).equals(invalid));
				assert(!fs.existsSync(f.file + '.lock'));
			}
		} finally { f.clean(); }
	});
	await test('directory, symlink and hardlinked destinations cannot redirect audit append', async () => {
		const f = fixture();
		try {
			fs.mkdirSync(f.file); await refused(f.audit, 'audit_invalid'); fs.rmdirSync(f.file);
			const target = path.join(f.root, 'target'); fs.mkdirSync(target);
			fs.symlinkSync(target, f.file, process.platform === 'win32' ? 'junction' : 'dir');
			await refused(f.audit, 'audit_invalid'); assert.deepStrictEqual(fs.readdirSync(target), []); fs.unlinkSync(f.file);
			fs.writeFileSync(f.file, ''); fs.linkSync(f.file, path.join(f.root, 'alias'));
			await refused(f.audit, 'audit_invalid'); assert.strictEqual(fs.readFileSync(f.file, 'utf8'), '');
		} finally { f.clean(); }
	});
	await test('terminal capacity is reserved before callback and a full audit preserves all records', async () => {
		const f = fixture();
		try {
			await seeded(f);
			const line = Buffer.from(JSON.stringify(records(f.file)[0]) + '\n');
			const original = Buffer.from(line.toString().repeat(Math.floor((CAP - 512) / line.length)));
			assert(CAP - original.length >= line.length);
			fs.writeFileSync(f.file, original);
			await refused(f.audit, 'audit_full'); assert(fs.readFileSync(f.file).equals(original));
			fs.appendFileSync(f.file, line.toString().repeat(10));
			const oversized = fs.readFileSync(f.file);
			assert(oversized.length > CAP); await refused(f.audit, 'audit_full'); assert(fs.readFileSync(f.file).equals(oversized));
		} finally { f.clean(); }
	});
	await test('stale or foreign locks fail promptly and are never taken over', async () => {
		const f = fixture();
		try {
			fs.writeFileSync(f.file + '.lock', 'foreign-lock');
			const old = new Date(0); fs.utimesSync(f.file + '.lock', old, old);
			const began = Date.now(); await refused(f.audit, 'audit_busy'); assert(Date.now() - began < 2000);
			assert.strictEqual(fs.readFileSync(f.file + '.lock', 'utf8'), 'foreign-lock'); assert(!fs.existsSync(f.file));
		} finally { f.clean(); }
	});
	await test('failed zero or partial token initialization removes only the created owned lock', async () => {
		for (const mode of ['zero', 'partial', 'replacement']) {
			const f = fixture(), open = fs.promises.open;
			try {
				fs.promises.open = async (...args) => {
					const handle = await open(...args);
					if (args[0] === f.file + '.lock' && args[1] === 'wx') {
						handle.writeFile = async () => {
							if (mode === 'partial') { await handle.write('partial', 0, 'utf8'); }
							if (mode === 'replacement') { fs.unlinkSync(f.file + '.lock'); fs.writeFileSync(f.file + '.lock', 'replacement'); }
							throw Object.assign(new Error('private filesystem message'), { code: 'ENOSPC' });
						};
					}
					return handle;
				};
				await refused(f.audit, 'audit_unavailable');
				assert(!fs.existsSync(f.file));
				if (mode === 'replacement') { assert.strictEqual(fs.readFileSync(f.file + '.lock', 'utf8'), 'replacement'); }
				else { assert(!fs.existsSync(f.file + '.lock')); }
			} finally { fs.promises.open = open; f.clean(); }
		}
	});
	await test('lock replacement during callback is preserved and prevents terminal append', async () => {
		const f = fixture();
		try {
			await refused(f.audit, 'audit_invalid', async () => {
				fs.unlinkSync(f.file + '.lock'); fs.writeFileSync(f.file + '.lock', 'replacement'); return completion;
			});
			assert.strictEqual(fs.readFileSync(f.file + '.lock', 'utf8'), 'replacement'); assert.strictEqual(records(f.file).length, 1);
		} finally { f.clean(); }
	});
	await test('audit changes during callback refuse completion without overwriting foreign bytes', async () => {
		const f = fixture();
		try {
			await refused(f.audit, 'audit_invalid', async () => { fs.appendFileSync(f.file, 'foreign-tail'); return completion; });
			assert(fs.readFileSync(f.file, 'utf8').endsWith('foreign-tail')); assert(!fs.existsSync(f.file + '.lock'));
		} finally { f.clean(); }
	});
	await test('cooperating processes contend at the real audit boundary without exceeding the cap', async () => {
		const f = fixture();
		let child;
		try {
			await seeded(f);
			const line = Buffer.from(JSON.stringify(records(f.file)[0]) + '\n');
			const original = Buffer.from(line.toString().repeat(Math.floor((CAP - 1600) / line.length)));
			fs.writeFileSync(f.file, original);
			const originalCount = original.length / line.length;
			const modulePath = require.resolve('../out/core/pipelineAudit');
			const source = `const {PipelineAudit}=require(${JSON.stringify(modulePath)});const audit=new PipelineAudit(${JSON.stringify(f.file)},['get_status']);` +
				`audit.withInvocation(${JSON.stringify(entry)},async()=>{console.log('held');await new Promise(resolve=>process.stdin.once('data',resolve));return ${JSON.stringify(completion)};}).then(()=>process.exit(0),error=>{console.error(error.code);process.exit(1)});`;
			child = cp.spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
			const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Owned audit child did not reach callback')), 5000);
				child.stdout.once('data', data => { clearTimeout(timeout); data.toString().includes('held') ? resolve() : reject(new Error('Unexpected owned child response')); });
			});
			const contender = cp.spawnSync(process.execPath, ['-e',
				`const {PipelineAudit}=require(${JSON.stringify(modulePath)});new PipelineAudit(${JSON.stringify(f.file)},['get_status']).withInvocation(${JSON.stringify(entry)},async()=>{console.log('backend');return ${JSON.stringify(completion)}}).catch(error=>console.log(error.code));`],
			{ encoding: 'utf8', timeout: 5000, windowsHide: true });
			assert.strictEqual(contender.status, 0); assert.strictEqual(contender.stdout.trim(), 'audit_busy');
			assert.strictEqual(records(f.file).length, originalCount + 1);
			child.stdin.end('release'); assert.strictEqual(await ended, 0, stderr);
			assert.strictEqual(records(f.file).length, originalCount + 2); assert(fs.statSync(f.file).size <= CAP);
			assert(fs.readFileSync(f.file).subarray(0, original.length).equals(original)); assert(!fs.existsSync(f.file + '.lock'));
		} finally { if (child && child.exitCode === null) { child.stdin.end('release'); await new Promise(resolve => child.once('exit', resolve)); } f.clean(); }
	});
	console.log('\n  ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
	if (failed) { process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
