import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type PipelineAuditClassification = 'read_only' | 'mutating' | 'destructive' | 'escape' | 'unknown';
export type PipelineAuditErrorCode = 'audit_unconfigured' | 'audit_unavailable' | 'audit_invalid' | 'audit_full' | 'audit_busy';
export class PipelineAuditError extends Error {
	constructor(public readonly code: PipelineAuditErrorCode) {
		super('Pipeline audit could not record this invocation (' + code + ').');
		this.name = 'PipelineAuditError';
	}
}
export interface PipelineAuditEntry {
	action: 'list' | 'run' | 'plan';
	command?: string;
	classification: PipelineAuditClassification;
	editorVersion?: string;
	editorPid?: number;
}
export interface PipelineAuditCompletion<T> {
	value: T;
	outcome: 'success' | 'failure' | 'refused';
	code?: string;
	nativeCode?: string;
	exitCode?: number;
	classification?: PipelineAuditClassification;
	editorVersion?: string;
	editorPid?: number;
}

const CAP_BYTES = 5 * 1024 * 1024;
const TERMINAL_RESERVE_BYTES = 1024;
const CLASSIFICATIONS = ['read_only', 'mutating', 'destructive', 'escape', 'unknown'];
const CODES = new Set(['started', 'ok', 'backend_error', 'unknown', 'invalid_arguments', 'project_metadata_invalid',
	'pipeline_pin_mismatch', 'target_unverified', 'invalid_catalog', 'provenance_unverified', 'policy_refused',
	'unknown_command', 'unknown_tool', 'cli_not_found', 'unsupported_binary', 'version_mismatch', 'tests_failed',
	'timed_out', 'cancelled', 'missing_editor', 'operation_failed', 'unknown_exit', 'invalid_output', 'spawn_failed', 'cleanup_failed']);
const NATIVE_CODES = new Set(['unknown', 'INVALID_COMMAND_ARGS', 'TESTS_FAILED', 'TEST_TIMED_OUT', 'COMMAND_FAILED', 'STATUS_NO_INSTANCES', 'STATUS_PIPELINE_LOAD_PENDING']);
const FIELDS = new Set(['invocationId', 'time', 'origin', 'action', 'command', 'classification', 'editorVersion', 'editorPid',
	'outcome', 'code', 'nativeCode', 'exitCode']);
export function normalizePipelineNativeCode(value: unknown): string | undefined {
	return value === undefined ? undefined : typeof value === 'string' && NATIVE_CODES.has(value) ? value : 'unknown';
}
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
type RecordEntry = Record<string, string | number>;

function integer(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}
function version(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 64 && /^\d{4}\.\d+\.\d+[abfp]\d+(?:_[0-9a-f]{12})?$/.test(value);
}
function localPath(value: string): boolean {
	return process.platform !== 'win32' || (/^[A-Za-z]:[\\/]/.test(value) && !value.slice(2).includes(':'));
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino;
}
function encode(record: RecordEntry): Buffer { return Buffer.from(JSON.stringify(record) + '\n', 'utf8'); }

/** Caller supplies an explicit path and a static reviewed command vocabulary. No path discovery or rotation. */
export class PipelineAudit {
	private readonly commands: Set<string>;
	constructor(private readonly auditPath: string | undefined, reviewedCommands: readonly string[] = []) {
		this.commands = new Set(reviewedCommands.filter(command => /^[a-z][a-z0-9_]{0,63}$/.test(command)));
	}

	private record(entry: PipelineAuditEntry, invocationId: string, outcome: string, completion?: PipelineAuditCompletion<unknown>): RecordEntry {
		const classification = completion?.classification ?? entry.classification;
		const result: RecordEntry = {
			invocationId, time: new Date().toISOString(), origin: 'pipeline', action: entry.action,
			command: typeof entry.command === 'string' && this.commands.has(entry.command) ? entry.command : 'unknown',
			classification: CLASSIFICATIONS.includes(classification) ? classification : 'unknown', outcome,
			code: completion ? (typeof completion.code === 'string' && CODES.has(completion.code) && completion.code !== 'started'
				? completion.code : outcome === 'success' && completion.code === undefined ? 'ok' : 'unknown') : 'started'
		};
		const editorVersion = completion?.editorVersion ?? entry.editorVersion;
		const editorPid = completion?.editorPid ?? entry.editorPid;
		if (version(editorVersion)) { result.editorVersion = editorVersion; }
		if (integer(editorPid) && editorPid > 0) { result.editorPid = editorPid; }
		const nativeCode = normalizePipelineNativeCode(completion?.nativeCode);
		if (nativeCode !== undefined) { result.nativeCode = nativeCode; }
		const exitCode = completion?.exitCode;
		if (integer(exitCode)) { result.exitCode = exitCode; }
		return result;
	}

	private validateExisting(bytes: Buffer): void {
		if (bytes.length === 0) { return; }
		if (bytes[bytes.length - 1] !== 10) { throw new PipelineAuditError('audit_invalid'); }
		for (const line of bytes.toString('utf8').slice(0, -1).split('\n')) {
			let record: RecordEntry;
			try { record = JSON.parse(line); } catch { throw new PipelineAuditError('audit_invalid'); }
			if (!record || typeof record !== 'object' || Array.isArray(record) || JSON.stringify(record) !== line
				|| Object.keys(record).some(key => !FIELDS.has(key))
				|| typeof record.invocationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.invocationId)
				|| typeof record.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.time)
				|| !Number.isFinite(Date.parse(record.time)) || new Date(record.time).toISOString() !== record.time
				|| record.origin !== 'pipeline' || typeof record.action !== 'string' || !['list', 'run', 'plan'].includes(record.action)
				|| typeof record.command !== 'string' || !(record.command === 'unknown' || this.commands.has(record.command))
				|| typeof record.classification !== 'string' || !CLASSIFICATIONS.includes(record.classification)
				|| typeof record.outcome !== 'string' || !['started', 'success', 'failure', 'refused'].includes(record.outcome)
				|| typeof record.code !== 'string' || !CODES.has(record.code)
				|| (record.outcome === 'started') !== (record.code === 'started')
				|| ('editorVersion' in record && !version(record.editorVersion))
				|| ('editorPid' in record && !(integer(record.editorPid) && record.editorPid > 0))
				|| ('nativeCode' in record && (typeof record.nativeCode !== 'string' || !NATIVE_CODES.has(record.nativeCode)))
				|| ('exitCode' in record && !integer(record.exitCode))) { throw new PipelineAuditError('audit_invalid'); }
		}
	}

	public async withInvocation<T>(entry: PipelineAuditEntry, callback: () => Promise<PipelineAuditCompletion<T>>): Promise<T> {
		if (!this.auditPath) { throw new PipelineAuditError('audit_unconfigured'); }
		if (!path.isAbsolute(this.auditPath) || path.extname(this.auditPath).toLowerCase() !== '.jsonl'
			|| !localPath(this.auditPath)
			|| !entry || !['list', 'run', 'plan'].includes(entry.action)) { throw new PipelineAuditError('audit_invalid'); }
		let lock: fs.promises.FileHandle | undefined, audit: fs.promises.FileHandle | undefined;
		let lockPath = '', token = '', lockIdentity: fs.Stats | undefined;
		let backendThrew = false, backendException: unknown;
		let lockInitialized = false;
		const ownsLock = async (requireToken = true): Promise<boolean> => {
			if (!lockIdentity) { return false; }
			let current: fs.promises.FileHandle | undefined;
			try {
				const named = await fs.promises.lstat(lockPath);
				if (!sameFile(named, lockIdentity)) { return false; }
				if (!requireToken) { return true; }
				if (named.size !== Buffer.byteLength(token)) { return false; }
				current = await fs.promises.open(lockPath, fs.constants.O_RDONLY | NO_FOLLOW);
				if (!sameFile(await current.stat(), lockIdentity)) { return false; }
				const bytes = Buffer.alloc(Buffer.byteLength(token));
				const read = await current.read(bytes, 0, bytes.length, 0);
				return read.bytesRead === bytes.length && bytes.toString('utf8') === token;
			} catch { return false; } finally { await current?.close(); }
		};
		try {
			const parent = await fs.promises.realpath(path.dirname(this.auditPath));
			if (!localPath(parent)) { throw new PipelineAuditError('audit_invalid'); }
			const auditPath = path.join(parent, path.basename(this.auditPath));
			lockPath = auditPath + '.lock';
			try { lock = await fs.promises.open(lockPath, 'wx', 0o600); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw new PipelineAuditError('audit_busy'); }
				throw error;
			}
			lockIdentity = await lock.stat();
			token = randomUUID();
			await lock.writeFile(token, 'utf8');
			lockInitialized = true;
			let named: fs.Stats;
			try { named = await fs.promises.lstat(auditPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
				audit = await fs.promises.open(auditPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_APPEND | NO_FOLLOW, 0o600);
				named = await fs.promises.lstat(auditPath);
			}
			if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) { throw new PipelineAuditError('audit_invalid'); }
			audit ??= await fs.promises.open(auditPath, fs.constants.O_RDWR | fs.constants.O_APPEND | NO_FOLLOW);
			const identity = await audit.stat();
			if (!sameFile(named, identity)) { throw new PipelineAuditError('audit_invalid'); }
			if (identity.size > CAP_BYTES) { throw new PipelineAuditError('audit_full'); }
			const bytes = Buffer.alloc(identity.size);
			let read = 0;
			while (read < bytes.length) {
				const chunk = await audit.read(bytes, read, bytes.length - read, read);
				if (!chunk.bytesRead) { throw new PipelineAuditError('audit_invalid'); }
				read += chunk.bytesRead;
			}
			this.validateExisting(bytes);
			const invocationId = randomUUID();
			const start = encode(this.record(entry, invocationId, 'started'));
			if (identity.size + start.length + TERMINAL_RESERVE_BYTES > CAP_BYTES) { throw new PipelineAuditError('audit_full'); }
			let expectedSize = identity.size;
			const append = async (record: Buffer): Promise<void> => {
				const current = await audit!.stat();
				if (!await ownsLock() || !sameFile(current, identity) || !sameFile(await fs.promises.lstat(auditPath), identity)
					|| current.size !== expectedSize) { throw new PipelineAuditError('audit_invalid'); }
				if (expectedSize + record.length > CAP_BYTES) { throw new PipelineAuditError('audit_full'); }
				await audit!.writeFile(record);
				await audit!.sync();
				expectedSize += record.length;
			};
			await append(start);
			let completion: PipelineAuditCompletion<T>;
			try { completion = await callback(); }
			catch (error) {
				await append(encode(this.record(entry, invocationId, 'failure', { value: undefined, outcome: 'failure', code: 'backend_error' })));
				backendThrew = true; backendException = error;
				throw error;
			}
			if (!completion || !['success', 'failure', 'refused'].includes(completion.outcome)) {
				await append(encode(this.record(entry, invocationId, 'failure', { value: undefined, outcome: 'failure', code: 'backend_error' })));
				throw new PipelineAuditError('audit_invalid');
			}
			const terminal = encode(this.record(entry, invocationId, completion.outcome, completion));
			if (terminal.length > TERMINAL_RESERVE_BYTES) { throw new PipelineAuditError('audit_invalid'); }
			await append(terminal);
			return completion.value;
		} catch (error) {
			if (error instanceof PipelineAuditError) { throw error; }
			// A backend exception has already received a terminal record; preserve it without logging its text.
			if (backendThrew && error === backendException) { throw error; }
			throw new PipelineAuditError('audit_unavailable');
		} finally {
			let cleanupFailed = false;
			try { await audit?.close(); } catch { cleanupFailed = true; }
			if (lock) {
				let owned = false, closed = false;
				try { owned = await ownsLock(lockInitialized); } catch { cleanupFailed = true; }
				try { await lock.close(); closed = true; } catch { cleanupFailed = true; }
				if (owned && closed) {
					try { await fs.promises.unlink(lockPath); } catch { cleanupFailed = true; }
				}
			}
			if (cleanupFailed) { throw new PipelineAuditError('audit_unavailable'); }
		}
	}
}
