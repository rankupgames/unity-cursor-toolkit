// Exercise the compiled CLI with synthetic artifacts and no Unity or IDE runtime.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-session-cli-'));
const project = path.join(root, 'project with spaces');
const storage = path.join(project, 'Library', 'UnityCursorToolkit', 'ProfilerSessions');
const saved = path.join(storage, 'saved'), temp = path.join(storage, 'temp');
const cli = path.join(__dirname, '..', 'out', 'sessions', 'cli.js');
const id = 'fixture-session', stamp = '2000-01-01T00:00:00.0000000Z';
const sessionFile = path.join(saved, id + '.json');
const transcriptFile = path.join(saved, id + '.console.json');
const session = {
	id, mode: 'play', startedUtc: stamp, capturedUtc: stamp, unityVersion: 'fixture-version', activeScene: '',
	bottleneck: 'unknown', sessionPath: 'historical/path/session.json', consoleTranscriptPath: 'historical/path/transcript.json',
	consoleEntryCount: 1, consoleErrorGroupCount: 1, consoleTrimmed: false, isPlaying: true, isPaused: false, isCompiling: false,
	frameBufferLength: 300, hierarchyEnabled: true, deepProfiling: false, frameTimingStatsEnabled: false,
	metrics: [{ category: 'fixture', name: 'counter', unit: 'count', error: '', valid: true, timingNanoseconds: false,
		count: 1, last: 1, min: 1, max: 1, avg: 1, values: [1] }], frameTimings: [], hotFrames: [], hotPaths: [], warnings: ['fixture warning']
};
const summary = { count: 1, firstIndex: 1, lastIndex: 1, firstTimestampUtc: stamp, lastTimestampUtc: stamp };
const transcript = {
	sessionId: id, startedUtc: stamp, capturedUtc: stamp, transcriptPath: 'historical/path/transcript.json', trimmed: false,
	entryCount: 1, groupCount: 1, errorGroupCount: 1,
	entries: [{ index: 1, key: 'fixture-group', type: 'error', timestampUtc: stamp, elapsedMs: 0 }],
	groups: { 'fixture-group': { key: 'fixture-group', type: 'error', message: 'fixture error', firstFrame: '', stackTrace: '',
		...summary, timeline: [{ index: 1, timestampUtc: stamp, elapsedMs: 0 }] } },
	errorGroups: { 'fixture-group': summary }
};
fs.mkdirSync(saved, { recursive: true });
fs.mkdirSync(temp);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const clone = value => JSON.parse(JSON.stringify(value));
const reset = () => { write(sessionFile, session); write(transcriptFile, transcript); };
reset();
write(path.join(temp, id + '.json'), { ...session, bottleneck: 'temporary fixture' });
fs.writeFileSync(path.join(saved, 'unrelated.txt'), 'preserve');
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
function run(...args) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 5000,
		env: { ...process.env, PATH: '', NODE_OPTIONS: '', UNITY_CURSOR_TOOLKIT_UNITY_PATH: path.join(root, 'missing-Unity') } });
	assert.ifError(result.error);
	return result;
}
const invoke = (action, ...args) => run(action, '--project', project, ...args);
function failure(result, code) {
	assert.strictEqual(result.status, 1, result.stdout + result.stderr);
	assert.strictEqual(result.stdout, '', 'Failure must not emit partial successful output');
	const output = JSON.parse(result.stderr);
	assert.strictEqual(output.success, false);
	assert.strictEqual(output.error.code, code);
	assert(!result.stderr.includes('fixture-private-marker'));
}

test('list inventories saved sessions, excludes companion transcripts, and preserves files', () => {
	const result = invoke('list');
	assert.strictEqual(result.status, 0, result.stderr); assert.strictEqual(result.stderr, '');
	const output = JSON.parse(result.stdout);
	assert.strictEqual(output.success, true); assert.strictEqual(output.sessions.length, 1);
	assert.deepStrictEqual(Object.keys(output.sessions[0]), ['id', 'kind', 'path', 'lastWriteUtc', 'bytes']);
	assert.strictEqual(output.sessions[0].id, id); assert.strictEqual(output.sessions[0].kind, 'saved');
	assert.strictEqual(output.sessions[0].bytes, fs.statSync(sessionFile).size);
	assert.strictEqual(fs.readFileSync(path.join(saved, 'unrelated.txt'), 'utf8'), 'preserve');
});
test('read returns the stored contract without Unity, VS Code, or resolving historical paths', () => {
	const result = invoke('read', '--id', id);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.deepStrictEqual(JSON.parse(result.stdout), { success: true, session });
	assert.strictEqual(run('read', '--project', project, '--id', id).stdout, result.stdout);
});
test('compact captures without optional raw counter arrays remain readable', () => {
	const compact = clone(session); delete compact.metrics[0].values; write(sessionFile, compact);
	const result = invoke('read', '--id', id);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.deepStrictEqual(JSON.parse(result.stdout).session, compact); reset();
});
test('console loads the adjacent matching transcript without following embedded paths', () => {
	const result = invoke('console', '--id', id);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.deepStrictEqual(JSON.parse(result.stdout), { success: true, id, consoleTranscript: transcript });
});
test('explicit temp scope selects the temporary capture with the same ID', () => {
	const result = invoke('read', '--scope', 'temp', '--id', id);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.strictEqual(JSON.parse(result.stdout).session.bottleneck, 'temporary fixture');
});
test('an existing empty scope is an empty inventory, while missing storage fails', () => {
	const empty = path.join(root, 'empty');
	fs.mkdirSync(path.join(empty, 'Library', 'UnityCursorToolkit', 'ProfilerSessions', 'saved'), { recursive: true });
	assert.deepStrictEqual(JSON.parse(run('list', '--project', empty).stdout), { success: true, sessions: [] });
	failure(run('list', '--project', path.join(root, 'missing')), 'not_found');
	failure(run('list', '--project', root), 'not_found');
	failure(invoke('read', '--id', 'missing'), 'not_found');
});
for (const args of [[], ['bogus'], ['list'], ['list', '--project'], ['list', '--project', ''],
	['list', '--project', project, '--project', project], ['list', '--project', project, '--unknown', 'x'],
	['list', '--project', project, '--scope', 'all'], ['list', '--project', project, '--id', id],
	['read', '--project', project], ['console', '--project', project, '--id', '../escape'],
	['read', '--project', project, '--id', 'x/y'], ['read', '--project', project, '--id', 'x\\y'],
	['read', '--project', project, '--id', 'x:stream'], ['read', '--project', project, '--id', 'x'.repeat(129)]]) {
	test('invalid arguments fail before file access: ' + JSON.stringify(args), () => failure(run(...args), 'invalid_arguments'));
}
for (const [name, mutate] of [
	['missing field', value => { delete value.metrics; }], ['empty identity', value => { value.id = ''; }],
	['wrong identity', value => { value.id = 'other-fixture'; }], ['wrong type', value => { value.isPlaying = 'true'; }],
	['null array', value => { value.warnings = null; }], ['unknown field', value => { value.token = 'fixture-private-marker'; }],
	['invalid timestamp', value => { value.capturedUtc = 'fixture-private-marker'; }],
	['backwards time', value => { value.startedUtc = '2000-01-02T00:00:00.000Z'; }],
	['negative count', value => { value.consoleEntryCount = -1; }], ['overflow', value => { value.frameBufferLength = 2147483648; }],
	['nested type', value => { value.metrics[0].avg = null; }], ['wrong mode', value => { value.mode = 'player'; }]
]) {
	test('read rejects ' + name, () => {
		const invalid = clone(session); mutate(invalid); write(sessionFile, invalid);
		failure(invoke('read', '--id', id), 'invalid_artifact'); reset();
	});
}
for (const source of ['', '{"private":"fixture-private-marker"', '[]', JSON.stringify(session).replace('"mode":"play"', '"mode":"editor","mode":"play"'),
	JSON.stringify(session).replace('"avg":1', '"avg":0,"a\\u0076g":1'),
	Buffer.from(JSON.stringify(session).replace('"activeScene":""', '"activeScene":"\xff"'), 'latin1')]) {
	test('read rejects malformed or duplicate JSON', () => {
		fs.writeFileSync(sessionFile, source); failure(invoke('read', '--id', id), 'invalid_artifact'); reset();
	});
}
for (const [name, mutate] of [
	['missing groups', value => { delete value.groups; }], ['foreign ID', value => { value.sessionId = 'foreign'; }],
	['different capture', value => { value.capturedUtc = '2000-01-02T00:00:00.000Z'; }],
	['inconsistent count', value => { value.entryCount = 2; }], ['missing error summary', value => { value.errorGroups = {}; }],
	['duplicate entry', value => { value.entries.push(value.entries[0]); value.entryCount = 2; }],
	['unknown group', value => { value.entries[0].key = 'missing'; }], ['conflicting group key', value => { value.groups['fixture-group'].key = 'other'; }],
	['wrong entry type', value => { value.entries[0].type = 'log'; }], ['wrong group count', value => { value.groups['fixture-group'].count = 2; }],
	['conflicting timeline', value => { value.groups['fixture-group'].timeline[0].index = 2; }],
	['conflicting group summary', value => { value.groups['fixture-group'].lastIndex = 2; }],
	['conflicting error summary', value => { value.errorGroups['fixture-group'].count = 2; }]
]) {
	test('console rejects ' + name, () => {
		const invalid = clone(transcript); mutate(invalid); write(transcriptFile, invalid);
		failure(invoke('console', '--id', id), 'invalid_artifact'); reset();
	});
}
test('a missing transcript never becomes an empty successful console', () => {
	fs.unlinkSync(transcriptFile); failure(invoke('console', '--id', id), 'not_found'); reset();
});
test('oversized artifacts fail before reading their contents', () => {
	fs.truncateSync(sessionFile, 64 * 1024 * 1024 + 1);
	failure(invoke('read', '--id', id), 'too_large'); reset();
});
test('hard-linked artifacts and a redirected storage directory are refused', () => {
	const linked = path.join(saved, 'linked.json'); fs.linkSync(sessionFile, linked);
	failure(invoke('read', '--id', id), 'unsafe_path'); failure(invoke('list'), 'unsafe_path'); fs.unlinkSync(linked);
	const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
	fs.renameSync(saved, saved + '-owned'); fs.symlinkSync(outside, saved, 'junction');
	failure(invoke('list'), 'unsafe_path'); fs.unlinkSync(saved); fs.renameSync(saved + '-owned', saved);
});
test('help is usable without a project and repeated reads leave all source bytes unchanged', () => {
	assert.strictEqual(run('--help').status, 0);
	assert.match(run('--help').stdout, /Default scope: saved/);
	assert.strictEqual(fs.readFileSync(sessionFile, 'utf8'), JSON.stringify(session));
	assert.strictEqual(fs.readFileSync(transcriptFile, 'utf8'), JSON.stringify(transcript));
});

assert.strictEqual(path.dirname(root), fs.realpathSync(os.tmpdir()));
assert(path.basename(root).startsWith('uct-session-cli-'));
fs.rmSync(root, { recursive: true });
console.log(`\n  ${passed} passed, 0 failed, ${passed} total`);
