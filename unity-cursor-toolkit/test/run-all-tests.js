/**
 * Runs every JavaScript test suite and reports one aggregate count that the
 * repository standards proof can verify.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const suites = [
	'run-tests.js',
	'simplified-context-tests.js',
	'remote-shell-tests.js'
];
const SUITE_TIMEOUT_MS = 30_000;

let passed = 0;
let failed = 0;
let total = 0;

for (const suite of suites) {
	const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
		encoding: 'utf8',
		env: process.env,
		maxBuffer: 256 * 1024 * 1024,
		timeout: SUITE_TIMEOUT_MS
	});

	process.stdout.write(result.stdout ?? '');
	process.stderr.write(result.stderr ?? '');

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
		break;
	}

	const summaries = [...(result.stdout ?? '').matchAll(/^\s+(\d+) passed, (\d+) failed, (\d+) total\s*$/gm)];
	const summary = summaries.at(-1);
	if (summary == null) {
		throw new Error(`Test suite did not report its counts: ${suite}`);
	}

	passed += Number(summary[1]);
	failed += Number(summary[2]);
	total += Number(summary[3]);
}

if (process.exitCode == null) {
	if (passed + failed !== total) {
		throw new Error(`Aggregate test counts are inconsistent: ${passed} passed + ${failed} failed != ${total} total`);
	}
	process.stdout.write(`\nTests: ${passed} passed, ${total} total\n`);
}
