import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const UNITY_CLI_EXPECTED_VERSION = '1.0.0-beta.12';

export type UnityCliErrorCode = 'cli_not_found' | 'unsupported_binary' | 'version_mismatch'
	| 'invalid_arguments' | 'tests_failed' | 'timed_out' | 'cancelled' | 'missing_editor'
	| 'operation_failed' | 'unknown_exit' | 'invalid_output' | 'policy_refused' | 'spawn_failed' | 'cleanup_failed';

export interface UnityCliError {
	code: UnityCliErrorCode;
	message: string;
	recovery: string;
	nativeCode?: string;
	editorVersion?: string;
	expectedVersion?: string;
	foundVersion?: string;
	outputExcerpt?: string;
	terminationReason?: 'timed_out' | 'cancelled';
}

interface UnityCliOutput {
	binaryPath?: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export type UnityCliResult<T = unknown> = UnityCliOutput & (
	{ ok: true; data: T; warnings: string[] } | { ok: false; error: UnityCliError }
);

export interface UnityCliInvocationOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	cwd?: string;
	readOnly?: boolean;
}

const OUTPUT_LIMIT = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 2000;
const EMPTY_OUTPUT: UnityCliOutput = { exitCode: null, signal: null, stdout: '', stderr: '' };

function failure(code: UnityCliErrorCode, message: string, recovery: string, output: UnityCliOutput = EMPTY_OUTPUT): Extract<UnityCliResult<never>, { ok: false }> {
	return { binaryPath: output.binaryPath, exitCode: output.exitCode, signal: output.signal, stdout: output.stdout, stderr: output.stderr, ok: false, error: { code, message, recovery } };
}

function resolveBinary(configuredPath: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	const override = configuredPath?.trim() || env.UNITY_CURSOR_TOOLKIT_UNITY_CLI_PATH?.trim();
	const candidates = override ? [override] : (env.PATH || env.Path || '').split(path.delimiter)
		.filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'unity.exe' : 'unity'));
	const found = candidates.find(candidate => {
		try {
			if (!fs.statSync(candidate).isFile()) { return false; }
			fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
			return true;
		} catch { return false; }
	});
	return found ? path.resolve(found) : undefined;
}

function parseOutput(output: UnityCliOutput, command: string, truncated: boolean): UnityCliResult {
	if (output.exitCode === 130 || output.exitCode === 143) {
		return failure('cancelled', 'Unity CLI was interrupted (exit ' + output.exitCode + ').', 'Retry the diagnostic when ready.', output);
	}
	let envelope: { success?: unknown; command?: unknown; data?: unknown; errors?: unknown; warnings?: unknown };
	try { envelope = JSON.parse(output.stdout); } catch { envelope = {}; }
	const errors = envelope?.errors;
	const warnings = envelope?.warnings;
	const valid = !truncated && envelope != null && typeof envelope === 'object'
		&& typeof envelope.success === 'boolean' && envelope.command === command
		&& Object.prototype.hasOwnProperty.call(envelope, 'data')
		&& Array.isArray(errors) && errors.every(error => error != null && typeof error === 'object'
			&& typeof error.code === 'string' && typeof error.message === 'string')
		&& Array.isArray(warnings) && warnings.every(warning => typeof warning === 'string');
	// Documented CLI exits; undocumented numeric codes must not collapse into an operation failure.
	if (output.exitCode === null || ![0, 1, 2, 3, 4, 6, 7, 8, 130, 143].includes(output.exitCode)) {
		const result = failure('unknown_exit', 'Unity CLI returned an undocumented exit: ' + (output.exitCode ?? output.signal ?? 'unknown') + '.', 'Inspect the pinned CLI output; do not retry as a classified operation failure.', output);
		if (valid && envelope.success === false) { result.error.nativeCode = (errors as { code: string }[])[0]?.code; }
		return result;
	}
	if (!valid || (envelope.success === true && (output.exitCode !== 0 || (errors as unknown[]).length !== 0))
		|| (envelope.success === false && (output.exitCode === 0 || (errors as unknown[]).length === 0))) {
		const result = failure('invalid_output', 'Unity CLI did not return one complete JSON result.', 'Keep the CLI version pinned and inspect the command output.', output);
		if (!result.ok) { result.error.outputExcerpt = output.stdout.slice(0, 500); }
		return result;
	}
	if (envelope.success === true) {
		return { ...output, ok: true, data: envelope.data, warnings: warnings as string[] };
	}
	const native = (errors as { code: string; message: string }[])[0];
	const code: UnityCliErrorCode = native.code === 'INVALID_COMMAND_ARGS' ? 'invalid_arguments'
		: native.code === 'TESTS_FAILED' ? 'tests_failed'
		: native.code === 'TEST_TIMED_OUT' ? 'timed_out' : 'operation_failed';
	const result = failure(code, native.message, code === 'invalid_arguments' ? 'Check the arguments against the pinned CLI help.'
		: code === 'tests_failed' ? 'Inspect the test results and fix the failing tests.'
		: code === 'timed_out' ? 'Inspect the Editor log before retrying with a longer deadline.'
		: 'Inspect the CLI diagnostic and Editor log; do not substitute another Editor.', output);
	if (!result.ok) {
		result.error.nativeCode = native.code;
		// This local diagnosis uses the recorded message; the CLI still reports COMMAND_FAILED.
		const missingEditor = native.code === 'COMMAND_FAILED' && /^Editor ([^\s]+) is not installed\. /.exec(native.message);
		if (missingEditor) {
			result.error.code = 'missing_editor';
			result.error.editorVersion = missingEditor[1];
			result.error.recovery = 'Install the declared Editor ' + missingEditor[1] + ' with the required modules, then retry.';
		}
	}
	return result;
}

/** Shell-free CLI transport. No Editor discovery, installation, or backend fallback. */
export class UnityCliAdapter {
	constructor(private readonly configuredPath?: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

	public async probe(options: UnityCliInvocationOptions): Promise<UnityCliResult<{ version: string; expectedVersion: string }>> {
		const result = await this.invoke('version', [], options);
		if (!result.ok) { return result; }
		const version = (result.data as { version?: unknown } | null)?.version;
		if (typeof version !== 'string' || version.length === 0) {
			return failure('invalid_output', 'Unity CLI version data is missing.', 'Check the pinned CLI installation.', result);
		}
		if (version !== UNITY_CLI_EXPECTED_VERSION) {
			return { ...failure('version_mismatch', '', '', result), error: {
				code: 'version_mismatch', message: 'Expected Unity CLI ' + UNITY_CLI_EXPECTED_VERSION + '; found ' + version + '.',
				recovery: 'Select the pinned CLI binary; no automatic install or upgrade is performed.',
				expectedVersion: UNITY_CLI_EXPECTED_VERSION, foundVersion: version
			} };
		}
		return { ...result, data: { version, expectedVersion: UNITY_CLI_EXPECTED_VERSION } };
	}

	public async invoke(command: string, args: readonly string[], options: UnityCliInvocationOptions): Promise<UnityCliResult> {
		if (!command || command.includes('\0') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
			return failure('invalid_arguments', 'CLI command and arguments must be valid strings.', 'Remove invalid argument characters.');
		}
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
			return failure('invalid_arguments', 'A positive CLI deadline is required.', 'Provide timeoutMs for this invocation.');
		}
		if (options.signal?.aborted) {
			return failure('cancelled', 'Unity CLI invocation was cancelled before starting.', 'Retry the diagnostic when ready.');
		}
		const transportArgs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
		if (transportArgs.some(arg => /^--(?:format|non-interactive|no-banner|no-log-proxy)(?:=|$)/.test(arg))) {
			return failure('invalid_arguments', 'CLI transport flags are managed by the adapter.', 'Remove format and interaction overrides.');
		}
		const pipelineVersions = command === 'pipeline' && args.length === 1 && args[0] === 'list-versions';
		const diagnostic = pipelineVersions || (['version', 'doctor'].includes(command) && args.length === 0)
			|| (command === 'status' && (args.length === 0 || (args.length === 2 && ['--project-path', '--project', '-p'].includes(args[0]) && args[1].length > 0)));
		if (options.readOnly !== false && !diagnostic) {
			return failure('policy_refused', 'Read-only CLI policy refused this invocation.', 'Use an approved diagnostic command and arguments.');
		}
		const binaryPath = resolveBinary(this.configuredPath, this.env);
		if (!binaryPath) {
			return failure('cli_not_found', 'Unity CLI binary was not found.', 'Set unityCursorToolkit.unityCli.path, UNITY_CURSOR_TOOLKIT_UNITY_CLI_PATH, or PATH.');
		}
		if (process.platform === 'win32' && !/\.exe$/i.test(binaryPath)) {
			return failure('unsupported_binary', 'Unity CLI requires a native executable on Windows.', 'Select unity.exe; shell wrappers are not used.');
		}
		return new Promise<UnityCliResult>(resolve => {
			let stdout = '', stderr = '', truncated = false, finished = false, stopping = false, exited = false, closed = false;
			let exitCode: number | null = null, signal: NodeJS.Signals | null = null;
			let closeResolve: () => void;
			const closePromise = new Promise<void>(done => { closeResolve = done; });
			const output = (): UnityCliOutput => ({ binaryPath, stdout, stderr, exitCode, signal });
			const finish = (result: UnityCliResult): void => {
				if (finished) { return; }
				finished = true;
				clearTimeout(deadline);
				options.signal?.removeEventListener('abort', cancel);
				resolve(result);
			};
			let child: ReturnType<typeof spawn>;
			try { child = spawn(binaryPath, [command, '--format', 'json', '--non-interactive', '--no-banner', '--no-log-proxy', ...args], {
				cwd: options.cwd, env: this.env, shell: false, windowsHide: true,
				detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
			}); } catch (error) {
				resolve(failure('spawn_failed', 'Unity CLI could not start: ' + (error as Error).message, 'Check the configured executable and permissions.', output()));
				return;
			}
			const waitForClose = (): Promise<boolean> => closed ? Promise.resolve(true) : new Promise(done => {
				const timer = setTimeout(() => done(false), CLEANUP_TIMEOUT_MS);
				void closePromise.then(() => { clearTimeout(timer); done(true); });
			});
			const stop = async (reason: 'cancelled' | 'timed_out'): Promise<void> => {
				if (finished || stopping) { return; }
				stopping = true;
				let terminated = false;
				try {
					if (!child.pid || (process.platform === 'win32' && exited)) {
						terminated = closed;
					} else if (process.platform === 'win32') {
						const systemRoot = this.env.SystemRoot || this.env.SYSTEMROOT;
						if (!systemRoot) { throw new Error('SystemRoot is missing; owned-process cleanup cannot run.'); }
						const killed = await new Promise<boolean>(done => execFile(path.join(systemRoot, 'System32', 'taskkill.exe'),
							['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: CLEANUP_TIMEOUT_MS }, error => done(!error)));
						terminated = killed && await waitForClose();
					} else {
						try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
						}
						await new Promise(done => setTimeout(done, 250));
						try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
						}
						terminated = await waitForClose();
					}
				} catch { terminated = false; }
				const result = terminated
					? failure(reason, reason === 'timed_out' ? 'Unity CLI exceeded the caller deadline; its owned process tree was terminated.'
						: 'Unity CLI was cancelled; its owned process tree was terminated.', 'Inspect partial artifacts before retrying.', output())
					: failure('cleanup_failed', 'Unity CLI ' + reason + '; owned-process termination could not be confirmed.',
						'Inspect the owned CLI process before retrying. User Editor processes were not targeted.', output());
				if (!result.ok) { result.error.terminationReason = reason; }
				finish(result);
			};
			const cancel = (): void => { void stop('cancelled'); };
			const deadline = setTimeout(() => { void stop('timed_out'); }, options.timeoutMs);
			options.signal?.addEventListener('abort', cancel, { once: true });
			const collect = (stream: 'stdout' | 'stderr', chunk: string): void => {
				const current = stream === 'stdout' ? stdout : stderr;
				if (current.length + chunk.length > OUTPUT_LIMIT) { truncated = true; }
				const text = (current + chunk).slice(0, OUTPUT_LIMIT);
				if (stream === 'stdout') { stdout = text; } else { stderr = text; }
			};
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => collect('stdout', chunk));
			child.stderr?.on('data', (chunk: string) => collect('stderr', chunk));
			child.once('error', error => finish(failure('spawn_failed', 'Unity CLI could not start: ' + error.message, 'Check the configured executable and permissions.', output())));
			child.once('exit', (code, exitSignal) => { exited = true; exitCode = code; signal = exitSignal; });
			child.once('close', (code, exitSignal) => {
				closed = true; exitCode = code; signal = exitSignal; closeResolve();
				if (!stopping) { finish(parseOutput(output(), command === 'pipeline' && ['list-versions', 'install', 'list'].includes(args[0]) ? 'pipeline ' + args[0] : command, truncated)); }
			});
		});
	}
}
