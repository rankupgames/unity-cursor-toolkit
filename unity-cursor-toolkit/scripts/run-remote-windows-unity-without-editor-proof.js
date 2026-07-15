#!/usr/bin/env node
/**
 * Local SSH wrapper for the Windows Unity Without Editor proof.
 *
 * The actual proof must execute on a Windows host with Unity and Cursor
 * installed. This wrapper reads the existing remote shell manifest, runs the
 * Windows proof runner in the remote repo, then fetches only the generated
 * artifact files back into the local audit tree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const runStamp = getStringArg('--stamp', `${dateStamp()}-windows`);
const manifestPath = path.resolve(getStringArg('--manifest', path.join(repoRoot, 'remote_workspace', 'unity-shell.json')));
const manifest = readManifest(manifestPath);
const remoteRepoPath = getStringArg('--remote-repo-path', manifest.remoteRepoPath || manifest.remoteWorkspacePath || '');
const sshTarget = getStringArg('--ssh-target', manifest.sshTarget || '');
const unityPath = getStringArg('--unity-path', process.env.UNITY_CURSOR_TOOLKIT_WINDOWS_UNITY_PATH || manifest.unityEditorPath || '');
const remoteOutRoot = getStringArg(
	'--remote-out-root',
	joinWindowsPath(remoteRepoPath, 'experiments', 'windows-unity-without-editor', 'results', runStamp)
);
const localOutRoot = path.resolve(getStringArg(
	'--local-out-root',
	path.join(repoRoot, 'experiments', 'windows-unity-without-editor', 'results', runStamp)
));
const dryRun = hasFlag('--dry-run');
const preflightOnly = hasFlag('--preflight-only') || hasFlag('--preflight');
const noFetch = hasFlag('--no-fetch');
const force = hasFlag('--force');
const reportPath = path.join(localOutRoot, 'remote-windows-proof-summary.json');
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	completedAt: null,
	mode: dryRun ? 'dry-run' : 'execute',
	status: dryRun ? 'planned' : 'running',
	platform: process.platform,
	arch: process.arch,
	osRelease: os.release(),
	manifestPath,
	sshTarget,
	remoteRepoPath,
	remoteOutRoot,
	localOutRoot,
	unityPath: unityPath || null,
	preflightOnly,
	fetchedFiles: [],
	steps: [],
	errors: []
};

main().catch((error) => {
	report.status = 'fail';
	report.completedAt = new Date().toISOString();
	report.errors.push(error.message || String(error));
	writeReport();
	console.error(`Remote Windows proof failed: ${error.message || String(error)}`);
	process.exitCode = 1;
});

async function main() {
	console.log('Unity Cursor Toolkit -- Remote Windows Unity Without Editor Proof\n');
	if (!sshTarget) {
		throw new Error(`manifest is missing sshTarget: ${manifestPath}`);
	}
	if (!remoteRepoPath) {
		throw new Error(`manifest is missing remoteRepoPath or remoteWorkspacePath: ${manifestPath}`);
	}

	fs.mkdirSync(localOutRoot, { recursive: true });
	writeReport();

	const remoteProofArgs = [
		'--out-root', remoteOutRoot,
		...(unityPath ? ['--unity-path', unityPath] : []),
		...(preflightOnly ? ['--preflight-only'] : []),
		...(force ? ['--force'] : [])
	];
	const remoteProofScript = [
		'$ErrorActionPreference = "Stop";',
		`Set-Location -LiteralPath ${quotePowerShell(remoteRepoPath)};`,
		`npm --prefix unity-cursor-toolkit run proof:windows-unity-without-editor -- ${remoteProofArgs.map(quotePowerShell).join(' ')};`,
		'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
	].join(' ');

	await runRemoteStep('remote-proof', remoteProofScript);

	if (noFetch === false) {
		await fetchRemoteArtifacts();
	}

	report.status = dryRun ? 'planned' : 'pass';
	report.completedAt = new Date().toISOString();
	writeReport();

	console.log('\nRemote Windows proof wrapper finished.');
	console.log(`Local artifact root: ${localOutRoot}`);
	console.log(`Local wrapper report: ${reportPath}`);
}

async function runRemoteStep(name, powerShellScript, options = {}) {
	const remoteCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(powerShellScript)}`;
	const args = [sshTarget, remoteCommand];
	const step = {
		name,
		command: 'ssh',
		args: redactArgs(args),
		powerShellScript: redactText(powerShellScript),
		startedAt: new Date().toISOString(),
		finishedAt: null,
		status: dryRun ? 'planned' : 'running',
		exitCode: null
	};
	report.steps.push(step);
	writeReport();
	console.log(`== ${name} ==`);
	console.log(formatCommand('ssh', step.args));

	if (dryRun) {
		step.finishedAt = new Date().toISOString();
		writeReport();
		return { stdout: '', stderr: '' };
	}

	const result = await spawnCapture('ssh', args);
	step.finishedAt = new Date().toISOString();
	step.exitCode = result.exitCode;
	step.status = result.exitCode === 0 ? 'pass' : 'fail';
	writeReport();
	if (result.stdout && options.printOutput !== false) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr && options.printOutput !== false) {
		process.stderr.write(result.stderr);
	}
	if (result.exitCode !== 0) {
		throw new Error(`${name} exited with code ${result.exitCode}`);
	}
	return result;
}

async function fetchRemoteArtifacts() {
	const fetchScript = [
		'$ErrorActionPreference = "Stop";',
		`$root = ${quotePowerShell(remoteOutRoot)};`,
		'if (-not (Test-Path -LiteralPath $root)) { throw "Remote proof output does not exist: $root" }',
		'Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object {',
		'  $relative = $_.FullName.Substring($root.Length).TrimStart("\\", "/");',
		'  $payload = @{ relativePath = $relative; base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) };',
		'  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress));',
		'}'
	].join(' ');
	const result = await runRemoteStep('fetch-artifacts', fetchScript, { printOutput: false });
	if (dryRun) {
		return;
	}
	for (const line of result.stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const entry = JSON.parse(trimmed);
		const relativePath = normalizeRelativeArtifactPath(entry.relativePath);
		const target = path.join(localOutRoot, relativePath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, Buffer.from(String(entry.base64), 'base64'));
		report.fetchedFiles.push(relativePath);
	}
	writeReport();
}

function spawnCapture(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
		child.on('error', reject);
		child.on('exit', (exitCode) => {
			resolve({
				exitCode,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8')
			});
		});
	});
}

function readManifest(candidate) {
	if (fs.existsSync(candidate) === false) {
		if (dryRunRequested()) {
			return {};
		}
		throw new Error(`remote manifest not found: ${candidate}`);
	}
	return JSON.parse(fs.readFileSync(candidate, 'utf8'));
}

function normalizeRelativeArtifactPath(value) {
	const text = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!text || text.includes('..') || path.isAbsolute(text) || /^[A-Za-z]:\//.test(text)) {
		throw new Error(`unsafe remote artifact path: ${value}`);
	}
	return text;
}

function redactArgs(args) {
	return args.map(redactText);
}

function redactText(value) {
	const text = String(value);
	return unityPath && text.includes(unityPath) ? text.replace(unityPath, '<UNITY_CURSOR_TOOLKIT_WINDOWS_UNITY_PATH>') : text;
}

function writeReport() {
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function joinWindowsPath(root, ...segments) {
	const trimmedRoot = String(root || '').replace(/[\\\/]+$/, '');
	const cleaned = segments.map((segment) => String(segment).replace(/^[\\\/]+|[\\\/]+$/g, ''));
	return [trimmedRoot, ...cleaned].filter(Boolean).join('\\');
}

function quotePowerShell(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
	return Buffer.from(script, 'utf16le').toString('base64');
}

function formatCommand(command, args) {
	return [command, ...args].map((value) => {
		const text = String(value);
		return /[\s"'`]/.test(text) ? JSON.stringify(text) : text;
	}).join(' ');
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

function dryRunRequested() {
	return process.argv.includes('--dry-run');
}
