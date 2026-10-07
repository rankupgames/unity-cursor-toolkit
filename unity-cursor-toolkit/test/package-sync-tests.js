// Exercise the public CLI against disposable package trees, never the real sample.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-package-sync-'));
const packageName = 'com.rankupgames.unity-cursor-toolkit';
const source = path.join(fixture, 'Packages', packageName);
const target = path.join(fixture, 'CursorUnityTool', 'Packages', packageName);
const script = path.join(fixture, 'unity-cursor-toolkit', 'scripts', 'sync-package.js');

function run(...args) {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: os.tmpdir() });
	if (result.error) throw result.error;
	return result;
}

try {
	fs.mkdirSync(path.dirname(script), { recursive: true });
	fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'sync-package.js'), script);
	fs.mkdirSync(path.join(source, 'Editor'), { recursive: true });
	fs.mkdirSync(path.join(target, 'obsolete'), { recursive: true });
	fs.writeFileSync(path.join(source, 'package.json'), '{"name":"canonical"}');
	fs.writeFileSync(path.join(source, 'Editor', 'Tool.cs.meta'), 'guid: canonical');
	fs.writeFileSync(path.join(source, 'Editor', 'debugger'), 'executable');
	fs.chmodSync(path.join(source, 'Editor', 'debugger'), 0o755);
	fs.writeFileSync(path.join(target, 'package.json'), '{"name":"stale"}');
	fs.writeFileSync(path.join(target, 'obsolete', 'Old.cs'), 'obsolete');

	// The former workflow did not detect drift. Check must fail without syncing.
	const check = run('--check');
	assert.strictEqual(check.status, 1, check.stderr);
	for (const entry of ['update package.json', 'add Editor', 'delete obsolete']) {
		assert.ok(check.stdout.includes(entry), check.stdout);
	}
	assert.strictEqual(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), '{"name":"stale"}');
	assert.ok(fs.existsSync(path.join(target, 'obsolete', 'Old.cs')));
	assert.ok(!fs.existsSync(path.join(target, 'Editor')));

	const sync = run();
	assert.strictEqual(sync.status, 0, sync.stderr);
	for (const relativePath of ['package.json', 'Editor/Tool.cs.meta', 'Editor/debugger']) {
		assert.deepStrictEqual(fs.readFileSync(path.join(target, relativePath)), fs.readFileSync(path.join(source, relativePath)));
	}
	if (process.platform !== 'win32') {
		assert.strictEqual(fs.statSync(path.join(target, 'Editor', 'debugger')).mode & 0o111, 0o111);
	}
	assert.ok(!fs.existsSync(path.join(target, 'obsolete')));
	assert.strictEqual(run('--check').status, 0);
	assert.match(run().stdout, /Package copies match/);

	// Unsafe entries and missing source data must fail before removing target files.
	fs.renameSync(source, `${source}-missing`);
	assert.strictEqual(run().status, 1);
	assert.ok(fs.existsSync(path.join(target, 'package.json')));
	fs.renameSync(`${source}-missing`, source);
	fs.symlinkSync(path.join(fixture, 'Packages'), path.join(target, 'redirect'), 'junction');
	assert.strictEqual(run().status, 1);
	assert.ok(fs.existsSync(path.join(source, 'package.json')));
	fs.unlinkSync(path.join(target, 'redirect'));
	fs.unlinkSync(path.join(target, 'package.json'));
	fs.linkSync(path.join(source, 'Editor', 'debugger'), path.join(target, 'package.json'));
	assert.strictEqual(run().status, 1, 'Hard links must fail before overwriting canonical source data');
	assert.strictEqual(fs.readFileSync(path.join(source, 'Editor', 'debugger'), 'utf8'), 'executable');
	console.log('  PASS  package sync detects drift without writes and mirrors safely\n\n  1 passed, 0 failed, 1 total');
} catch (error) {
	console.error(error);
	console.log('  0 passed, 1 failed, 1 total');
	process.exitCode = 1;
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
