#!/usr/bin/env node
/**
 * Dry-run-first wrapper for Unity's official command-line licensing flows.
 *
 * This script never patches, proxies, or bypasses Unity licensing. It only
 * builds and, when explicitly requested with --execute, runs the Unity Editor
 * command lines documented by Unity for activation, return, and manual
 * activation files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const defaultProjectRoot = path.join(repoRoot, 'CursorUnityTool');

function main(argv = process.argv.slice(2), env = process.env) {
	let parsed;
	try {
		parsed = parseArgs(argv);
		if (parsed.help || parsed.command == null) {
			printUsage();
			return parsed.command == null && !parsed.help ? 1 : 0;
		}

		if (parsed.command === 'status') {
			printStatus(parsed, env);
			return 0;
		}

		const plan = createLicensePlan(parsed.command, parsed, env);
		if (plan.execute) {
			return executePlan(plan);
		}

		printDryRun(plan);
		return 0;
	} catch (error) {
		console.error(`unity-license: ${error.message || String(error)}`);
		return 1;
	}
}

function parseArgs(argv) {
	const result = {
		command: null,
		execute: false,
		dryRun: true,
		manual: false,
		namedUser: false,
		json: false,
		help: false,
		flags: {}
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--execute') {
			result.execute = true;
			result.dryRun = false;
			continue;
		}
		if (arg === '--dry-run') {
			result.execute = false;
			result.dryRun = true;
			continue;
		}
		if (arg === '--manual') {
			result.manual = true;
			continue;
		}
		if (arg === '--named-user') {
			result.namedUser = true;
			continue;
		}
		if (arg === '--json') {
			result.json = true;
			continue;
		}
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			if (eq >= 0) {
				result.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
				continue;
			}

			const key = arg.slice(2);
			if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
				result.flags[key] = argv[++i];
			} else {
				result.flags[key] = 'true';
			}
			continue;
		}

		if (result.command == null) {
			result.command = arg;
			continue;
		}

		throw new Error(`unexpected positional argument: ${arg}`);
	}

	if (result.command != null && !['activate', 'return', 'status'].includes(result.command)) {
		throw new Error(`unknown command "${result.command}"`);
	}

	return result;
}

function createLicensePlan(command, options, env = process.env) {
	const execute = options.execute === true;
	const projectPath = stringFlag(options, 'project', defaultProjectRoot);
	const platform = stringFlag(options, 'platform', process.platform);
	const unityPath = resolveUnityPath({
		platform,
		projectPath,
		override: firstNonEmpty(stringFlag(options, 'unity-path'), env.UNITY_CURSOR_TOOLKIT_UNITY_PATH),
		requireExists: execute
	});
	const cwd = path.resolve(stringFlag(options, 'cwd', process.cwd()));
	const logFile = stringFlag(options, 'log-file');
	let args;
	let description;
	let requiredEnv = [];

	if (command === 'activate' && options.manual) {
		const ulfPath = stringFlag(options, 'ulf');
		if (ulfPath) {
			args = ['-batchmode', '-manualLicenseFile', ulfPath];
			description = 'manual license file import';
			if (execute && !fs.existsSync(ulfPath)) {
				throw new Error(`manual license file not found: ${ulfPath}`);
			}
		} else {
			args = ['-batchmode', '-createManualActivationFile'];
			description = 'manual activation request file creation';
		}
		appendLogFile(args, logFile);
	} else if (command === 'activate') {
		const email = readCredential(options, env, 'username', 'UNITY_EMAIL', execute);
		const password = readCredential(options, env, 'password', 'UNITY_PASSWORD', execute);
		const serial = readCredential(options, env, 'serial', 'UNITY_SERIAL', execute && !options.namedUser);
		args = ['-quit', '-batchmode', '-serial'];
		if (!options.namedUser && serial.value) {
			args.push(serial.value);
		}
		args.push('-username', email.value, '-password', password.value);
		description = options.namedUser ? 'named-user license activation' : 'serial license activation';
		requiredEnv = requiredEnv.concat(email.envName, password.envName);
		if (!options.namedUser) {
			requiredEnv.push(serial.envName);
		}
	} else if (command === 'return') {
		const email = readCredential(options, env, 'username', 'UNITY_EMAIL', execute);
		const password = readCredential(options, env, 'password', 'UNITY_PASSWORD', execute);
		args = ['-quit', '-batchmode', '-returnlicense', '-username', email.value, '-password', password.value];
		description = 'license return';
		requiredEnv = requiredEnv.concat(email.envName, password.envName);
	} else {
		throw new Error(`unsupported command for plan: ${command}`);
	}

	return {
		command,
		description,
		execute,
		projectPath,
		unityPath,
		args,
		cwd,
		requiredEnv: Array.from(new Set(requiredEnv.filter(Boolean))),
		maskedCommand: formatCommand(unityPath, maskArgs(args, env))
	};
}

function executePlan(plan) {
	const result = spawnSync(plan.unityPath, plan.args, {
		cwd: plan.cwd,
		stdio: 'inherit'
	});

	if (result.error) {
		console.error(`unity-license: failed to run Unity: ${result.error.message || String(result.error)}`);
		return 1;
	}
	return typeof result.status === 'number' ? result.status : 1;
}

function printDryRun(plan) {
	console.log(`Unity license ${plan.description} (dry run)`);
	console.log(plan.maskedCommand);
	if (plan.requiredEnv.length > 0) {
		console.log(`required env: ${plan.requiredEnv.join(', ')}`);
	}
	console.log('Add --execute to run this command against the installed Unity Editor.');
}

function printStatus(options, env) {
	const platform = stringFlag(options, 'platform', process.platform);
	const projectPath = stringFlag(options, 'project', defaultProjectRoot);
	const unityPath = resolveUnityPath({
		platform,
		projectPath,
		override: firstNonEmpty(stringFlag(options, 'unity-path'), env.UNITY_CURSOR_TOOLKIT_UNITY_PATH),
		requireExists: false
	});
	const candidates = getLicenseFileCandidates(platform, env).map(candidate => ({
		path: candidate,
		exists: fs.existsSync(candidate)
	}));
	const payload = {
		unityPath,
		licenseFiles: candidates,
		env: {
			UNITY_EMAIL: Boolean(env.UNITY_EMAIL),
			UNITY_PASSWORD: Boolean(env.UNITY_PASSWORD),
			UNITY_SERIAL: Boolean(env.UNITY_SERIAL),
			UNITY_CURSOR_TOOLKIT_UNITY_PATH: Boolean(env.UNITY_CURSOR_TOOLKIT_UNITY_PATH)
		},
		note: 'Unity does not expose a stable Editor CLI status command in the documented activation flow; verify active seats in Unity Hub or the Unity ID portal.'
	};

	if (options.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log('Unity license status inputs');
	console.log(`Unity: ${unityPath}`);
	console.log('Known license files:');
	for (const candidate of candidates) {
		console.log(`  ${candidate.exists ? 'present ' : 'missing '} ${candidate.path}`);
	}
	console.log(`Env present: UNITY_EMAIL=${payload.env.UNITY_EMAIL} UNITY_PASSWORD=${payload.env.UNITY_PASSWORD} UNITY_SERIAL=${payload.env.UNITY_SERIAL}`);
	console.log(payload.note);
}

function resolveUnityPath(options) {
	for (const candidate of expandUnityPath(options.override, options.platform)) {
		if (!options.requireExists || fs.existsSync(candidate)) {
			return candidate;
		}
	}

	const version = readProjectVersion(options.projectPath);
	if (version) {
		for (const candidate of defaultUnityCandidates(version, options.platform)) {
			if (!options.requireExists || fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	if (options.requireExists) {
		throw new Error('Unity Editor executable not found. Set --unity-path or UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
	}

	return defaultUnityCandidates(version || '<version>', options.platform)[0];
}

function expandUnityPath(candidate, platform) {
	if (candidate == null || String(candidate).trim().length === 0) {
		return [];
	}

	const trimmed = String(candidate).trim();
	if (platform === 'darwin' && trimmed.endsWith('.app')) {
		return [path.join(trimmed, 'Contents', 'MacOS', 'Unity'), trimmed];
	}
	if (platform === 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity.exe'), trimmed];
	}
	if (platform !== 'darwin' && platform !== 'win32' && /[\\/]Editor$/i.test(trimmed)) {
		return [path.join(trimmed, 'Unity'), trimmed];
	}
	return [trimmed];
}

function defaultUnityCandidates(version, platform) {
	if (platform === 'darwin') {
		return [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`];
	}
	if (platform === 'win32') {
		return [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`];
	}
	return [`/opt/Unity/Hub/Editor/${version}/Editor/Unity`];
}

function readProjectVersion(projectPath) {
	try {
		const text = fs.readFileSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
		const match = /^m_EditorVersion:\s*(.+)$/m.exec(text);
		return match == null ? null : match[1].trim();
	} catch {
		return null;
	}
}

function getLicenseFileCandidates(platform, env = process.env) {
	if (platform === 'win32') {
		return [
			path.win32.join(env.PROGRAMDATA || 'C:\\ProgramData', 'Unity', 'Unity_lic.ulf')
		];
	}

	const home = env.HOME || os.homedir();
	if (platform === 'darwin') {
		return [
			'/Library/Application Support/Unity/Unity_lic.ulf',
			path.join(home, 'Library', 'Application Support', 'Unity', 'Unity_lic.ulf')
		];
	}

	return [
		'/usr/share/unity3d/Unity_lic.ulf',
		path.join(home, '.local', 'share', 'unity3d', 'Unity_lic.ulf')
	];
}

function appendLogFile(args, logFile) {
	if (logFile && logFile.trim().length > 0) {
		args.push('-logFile', logFile);
		return;
	}
	args.push('-logFile', '-');
}

function readCredential(options, env, flagName, envName, required) {
	const value = firstNonEmpty(stringFlag(options, flagName), env[envName], `<${envName}>`);
	if (required && (value === `<${envName}>` || value.length === 0)) {
		throw new Error(`missing required ${envName}; pass it via environment, not a repo file`);
	}
	return { value, envName };
}

function maskArgs(args, env) {
	const secretValues = new Map([
		[env.UNITY_EMAIL, '<UNITY_EMAIL>'],
		[env.UNITY_PASSWORD, '<UNITY_PASSWORD>'],
		[env.UNITY_SERIAL, '<UNITY_SERIAL>']
	].filter(([value]) => value != null && String(value).length > 0));

	return args.map(arg => secretValues.get(arg) || arg);
}

function formatCommand(executable, args) {
	return [quoteShell(executable)].concat(args.map(quoteShell)).join(' ');
}

function quoteShell(value) {
	const text = String(value);
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
		return text;
	}
	return JSON.stringify(text);
}

function stringFlag(options, name, fallback = '') {
	const value = options.flags && options.flags[name];
	if (value == null || value === true) {
		return fallback;
	}
	return String(value);
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (value != null && String(value).trim().length > 0) {
			return String(value).trim();
		}
	}
	return undefined;
}

function printUsage() {
	console.log(`Unity Cursor Toolkit license helper

Usage:
  node scripts/unity-license.js activate [--named-user] [--execute]
  node scripts/unity-license.js activate --manual [--ulf path/to/license.ulf] [--execute]
  node scripts/unity-license.js return [--execute]
  node scripts/unity-license.js status [--json]

Credentials are read from env only:
  UNITY_EMAIL, UNITY_PASSWORD, UNITY_SERIAL

Options:
  --unity-path <path>  Installed Unity executable, Unity.app, or Editor dir
  --project <path>     Unity project used to resolve ProjectVersion.txt
  --cwd <path>         Working directory for manual .alf creation
  --log-file <path>    Unity log path for manual activation/import
  --dry-run            Print masked command only (default)
  --execute            Actually run the installed Unity Editor command
`);
}

if (require.main === module) {
	process.exitCode = main();
}

module.exports = {
	createLicensePlan,
	defaultUnityCandidates,
	expandUnityPath,
	getLicenseFileCandidates,
	main,
	maskArgs,
	parseArgs,
	resolveUnityPath
};
