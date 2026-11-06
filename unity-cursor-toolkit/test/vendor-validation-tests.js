const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sha256ReviewedFile } = require('../scripts/validate-vendored-unterm');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-unterm-vendor-hash-'));
try {
	const lfPath = path.join(temporaryRoot, 'notices-lf.md');
	const crlfPath = path.join(temporaryRoot, 'notices-crlf.md');
	const driftPath = path.join(temporaryRoot, 'notices-drift.md');
	fs.writeFileSync(lfPath, 'First notice\nSecond notice\n', 'utf8');
	fs.writeFileSync(crlfPath, 'First notice\r\nSecond notice\r\n', 'utf8');
	fs.writeFileSync(driftPath, 'First notice\nChanged notice\n', 'utf8');

	const expectedHash = sha256ReviewedFile(lfPath);
	assert.strictEqual(sha256ReviewedFile(crlfPath), expectedHash, 'LF and CRLF notice files must validate identically');
	assert.notStrictEqual(sha256ReviewedFile(driftPath), expectedHash, 'real notice content drift must still fail the reviewed hash');
	console.log('Validated cross-platform vendored notice hashing');
} finally {
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
