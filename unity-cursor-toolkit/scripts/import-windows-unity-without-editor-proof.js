#!/usr/bin/env node
/**
 * Imports an executed Windows proof artifact directory into the local audit tree.
 *
 * Use this when the Windows proof was run directly on a Windows host and the
 * generated result folder was copied back manually. This script does not relax
 * validation: after import it runs the same fulfillment audit used everywhere
 * else, so dry-run or incomplete summaries remain non-proof.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const sourceArg = getStringArg('--from', getStringArg('--source', ''));
const destNameArg = getStringArg('--dest-name', getStringArg('--stamp', ''));
const dryRun = hasFlag('--dry-run');
const skipAudit = hasFlag('--skip-audit');
const force = hasFlag('--force');

main();

function main() {
	try {
		if (!sourceArg) {
			throw new Error('missing --from <windows-proof-result-folder>');
		}
		const sourceRoot = path.resolve(sourceArg);
		const summaryPath = findSummaryPath(sourceRoot);
		const summary = readJson(summaryPath);
		const destName = sanitizeDestName(destNameArg || path.basename(path.dirname(summaryPath)));
		const destRoot = path.join(repoRoot, 'experiments', 'windows-unity-without-editor', 'results', destName);
		const plan = {
			schemaVersion: 1,
			mode: dryRun ? 'dry-run' : 'execute',
			sourceRoot,
			summaryPath,
			destRoot,
			summaryStatus: summary.status,
			summaryMode: summary.mode,
			summaryPlatform: summary.platform,
			windowsHost: summary.windowsHost,
			copiedFiles: listFiles(path.dirname(summaryPath)).map((file) => path.relative(path.dirname(summaryPath), file).replace(/\\/g, '/'))
		};

		validateSummaryHeader(summary);
		if (fs.existsSync(destRoot) && force === false && dryRun === false) {
			throw new Error(`destination already exists: ${destRoot}; pass --force to replace it`);
		}

		if (dryRun) {
			process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
			return;
		}

		fs.rmSync(destRoot, { recursive: true, force: true });
		copyDirectory(path.dirname(summaryPath), destRoot);
		if (skipAudit === false) {
			runAudit();
		}
		process.stdout.write(JSON.stringify({ ...plan, imported: true }, null, 2) + '\n');
	} catch (error) {
		console.error(error.message || String(error));
		process.exitCode = 1;
	}
}

function validateSummaryHeader(summary) {
	if (summary.schemaVersion !== 1) {
		throw new Error(`Windows proof summary has unsupported schemaVersion: ${summary.schemaVersion}`);
	}
	if (summary.mode !== 'execute') {
		throw new Error(`Windows proof summary is not an executed proof: ${summary.mode}`);
	}
	if (summary.platform !== 'win32' || summary.windowsHost !== true) {
		throw new Error(`Windows proof summary was not produced on a Windows host: ${summary.platform}`);
	}
	if (summary.status !== 'pass') {
		throw new Error(`Windows proof summary did not pass: ${summary.status}`);
	}
}

function findSummaryPath(sourceRoot) {
	if (fs.existsSync(sourceRoot) === false) {
		throw new Error(`source folder not found: ${sourceRoot}`);
	}
	const stat = fs.statSync(sourceRoot);
	if (stat.isFile()) {
		if (path.basename(sourceRoot) !== 'windows-proof-summary.json') {
			throw new Error('source file must be windows-proof-summary.json');
		}
		return sourceRoot;
	}
	const direct = path.join(sourceRoot, 'windows-proof-summary.json');
	if (fs.existsSync(direct)) {
		return direct;
	}
	const matches = listFiles(sourceRoot).filter((file) => path.basename(file) === 'windows-proof-summary.json');
	if (matches.length !== 1) {
		throw new Error(`expected exactly one windows-proof-summary.json under ${sourceRoot}; found ${matches.length}`);
	}
	return matches[0];
}

function runAudit() {
	const result = spawnSync(process.execPath, [
		path.join(extensionRoot, 'scripts', 'audit-unity-without-editor.js'),
		'--strict',
		'--out',
		path.join(repoRoot, 'experiments', 'unity-without-editor-audit', 'results', `${dateStamp()}-current.json`)
	], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: 'inherit'
	});
	if (result.status !== 0) {
		throw new Error(`imported proof failed fulfillment audit with exit code ${result.status}`);
	}
}

function listFiles(root) {
	const files = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolutePath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(absolutePath);
			} else if (entry.isFile()) {
				files.push(absolutePath);
			}
		}
	}
	return files.sort();
}

function copyDirectory(source, target) {
	fs.mkdirSync(target, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const sourcePath = path.join(source, entry.name);
		const targetPath = path.join(target, entry.name);
		if (entry.isDirectory()) {
			copyDirectory(sourcePath, targetPath);
		} else if (entry.isFile()) {
			fs.copyFileSync(sourcePath, targetPath);
		}
	}
}

function sanitizeDestName(value) {
	const cleaned = String(value || '').trim();
	if (!cleaned || cleaned.includes('/') || cleaned.includes('\\') || cleaned === '.' || cleaned === '..') {
		throw new Error(`invalid destination name: ${value}`);
	}
	return cleaned.replace(/[^A-Za-z0-9._-]/g, '-');
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function dateStamp() {
	return new Date().toISOString().slice(0, 10);
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	const prefix = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}
