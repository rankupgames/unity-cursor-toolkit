// Exercise the operator CLI boundary without contacting Jenkins or GitHub.
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../ci/jenkins/request.js');
const sha = 'a'.repeat(40);
const args = ['--branch', 'fixture/check', '--source-sha', sha, '--lane', 'check'];
let passed = 0;
function run(input) {
	const result = spawnSync(process.execPath, [script, ...input], { encoding: 'utf8', timeout: 5000 });
	assert.ifError(result.error);
	return result;
}
const result = run(args);
assert.equal(result.status, 0);
assert.equal(result.stderr, '');
assert.deepEqual(JSON.parse(result.stdout), { version: 1,
	repository: 'https://github.com/rankupgames/unity-cursor-toolkit.git',
	branch: 'fixture/check', sourceSha: sha, lane: 'check' });
passed++;
const invalid = [
	[], args.slice(0, -1), [...args, '--extra', 'value'], [...args, '--lane', 'check'],
	['--repository', 'https://example.invalid/repo.git', ...args.slice(2)],
	...['', '-main', 'a//b', 'a/../b', 'a/.hidden', 'a/b.lock', 'a/b.', 'a\nb', 'a;id', 'a'.repeat(129)]
		.map(branch => ['--branch', branch, ...args.slice(2)]),
	...['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${sha};id`]
		.map(value => [...args.slice(0, 3), value, ...args.slice(4)]),
	[...args.slice(0, -1), 'publish']
];
for (const input of invalid) {
	const result = run(input);
	assert.equal(result.status, 1, JSON.stringify(input));
	assert.equal(result.stdout, '', 'Invalid input must not emit a partial request');
	assert.equal(JSON.parse(result.stderr).code, 'invalid_dispatch_arguments');
	passed++;
}
console.log(`\n  ${passed} passed, 0 failed, ${passed} total`);
