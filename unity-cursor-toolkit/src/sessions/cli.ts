#!/usr/bin/env node

/** Read existing profiler artifacts without connecting to or starting Unity. */
import * as fs from 'fs/promises';
import * as path from 'path';

type JsonObject = Record<string, unknown>;
type Rule = (value: unknown) => boolean;
type ErrorCode = 'invalid_arguments' | 'not_found' | 'unsafe_path' | 'too_large' | 'invalid_artifact' | 'read_failed';
const MAX_BYTES = 64 * 1024 * 1024; // Matches the recorder's temporary artifact budget.
const SESSION_ROOT = ['Library', 'UnityCursorToolkit', 'ProfilerSessions'];
const USAGE = 'Usage: sessions <list|read|console> --project <Unity-project> [--scope saved|temp] [--id <session-id>]\n'
	+ 'Default scope: saved. Clipboard captures use temp until explicitly saved. Output is JSON.\n';

class SessionError extends Error {
	constructor(readonly code: ErrorCode, message: string) { super(message); }
}

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const text: Rule = value => typeof value === 'string';
const nonempty: Rule = value => typeof value === 'string' && value.length > 0;
const boolean: Rule = value => typeof value === 'boolean';
const finite: Rule = value => typeof value === 'number' && Number.isFinite(value);
const count: Rule = value => finite(value) && Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647;
const timestamp: Rule = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(value) && Number.isFinite(Date.parse(value));
const array = (rule: Rule): Rule => value => Array.isArray(value) && value.every(rule);
const shape = (required: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule => value => object(value)
	&& Object.entries(required).every(([key, rule]) => Object.prototype.hasOwnProperty.call(value, key) && rule(value[key]))
	&& Object.keys(value).every(key => Object.prototype.hasOwnProperty.call(required, key)
		|| (Object.prototype.hasOwnProperty.call(optional, key) && optional[key](value[key])));
const fields = (names: string[], rule: Rule): Record<string, Rule> => Object.fromEntries(names.map(name => [name, rule]));
const logType: Rule = value => ['log', 'warning', 'error', 'exception', 'assert'].includes(value as string);
const occurrence = shape({ index: count, timestampUtc: timestamp, elapsedMs: finite });
const group = shape({ ...fields(['key', 'message', 'firstFrame', 'stackTrace'], text), type: logType,
	...fields(['count', 'firstIndex', 'lastIndex'], count), firstTimestampUtc: timestamp, lastTimestampUtc: timestamp, timeline: array(occurrence) });
const errorGroup = shape({ ...fields(['count', 'firstIndex', 'lastIndex'], count), firstTimestampUtc: timestamp, lastTimestampUtc: timestamp });
const dictionary = (rule: Rule): Rule => value => object(value) && Object.values(value).every(rule);
const metric = shape({ ...fields(['category', 'name', 'unit', 'error'], text), valid: boolean, timingNanoseconds: boolean,
	count, ...fields(['last', 'min', 'max', 'avg'], finite) }, { values: array(finite) });
const sessionRule = shape({
	...fields(['id', 'unityVersion'], nonempty), ...fields(['startedUtc', 'capturedUtc'], timestamp),
	mode: value => value === 'play' || value === 'editor',
	...fields(['activeScene', 'bottleneck', 'sessionPath', 'consoleTranscriptPath'], text),
	...fields(['consoleEntryCount', 'consoleErrorGroupCount', 'frameBufferLength'], count),
	...fields(['consoleTrimmed', 'isPlaying', 'isPaused', 'isCompiling', 'hierarchyEnabled', 'deepProfiling', 'frameTimingStatsEnabled'], boolean),
	metrics: array(metric), warnings: array(text),
	frameTimings: array(shape(fields(['cpuFrameTimeMs', 'gpuFrameTimeMs', 'cpuMainThreadFrameTimeMs', 'cpuRenderThreadFrameTimeMs', 'cpuMainThreadPresentWaitTimeMs'], finite))),
	hotFrames: array(shape({ frameIndex: count, threadName: text, cpuFrameTimeMs: finite, gpuFrameTimeMs: finite })),
	hotPaths: array(shape({ name: text, path: text, framesSeen: count, ...fields(['totalTimeMs', 'selfTimeMs', 'maxTimeMs', 'gcBytes', 'calls'], finite) }))
});
const transcriptRule = shape({ sessionId: nonempty, startedUtc: timestamp, capturedUtc: timestamp, transcriptPath: text,
	trimmed: boolean, entryCount: count, groupCount: count, errorGroupCount: count,
	entries: array(shape({ index: count, key: nonempty, type: logType, timestampUtc: timestamp, elapsedMs: finite })),
	groups: dictionary(group), errorGroups: dictionary(errorGroup) });

function parseOptions(argv: string[]): { action: string; project: string; scope: string; id?: string } {
	const [action, ...args] = argv;
	if (!['list', 'read', 'console'].includes(action) || args.length % 2 !== 0) {
		throw new SessionError('invalid_arguments', USAGE.trim());
	}
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index], value = args[index + 1];
		if (!['--project', '--scope', '--id'].includes(key) || values.has(key) || !value.trim() || value.startsWith('--')) {
			throw new SessionError('invalid_arguments', 'Options must be known, unique, and have a nonempty value.');
		}
		values.set(key, value);
	}
	const project = values.get('--project'), scope = values.get('--scope') ?? 'saved', id = values.get('--id');
	if (!project || !['saved', 'temp'].includes(scope) || (action === 'list' ? id !== undefined : !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
		throw new SessionError('invalid_arguments', 'Specify --project, scope saved or temp, and --id only for read or console.');
	}
	return { action, project, scope, id };
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function artifactPath(directory: string, name: string): Promise<string> {
	const file = path.join(directory, name);
	const info = await fs.lstat(file);
	if (!info.isFile() || info.nlink !== 1 || !isWithin(directory, await fs.realpath(file))) {
		throw new SessionError('unsafe_path', 'Session artifacts must be regular, unlinked files inside the selected storage directory.');
	}
	return file;
}

async function readObject(file: string): Promise<JsonObject> {
	const handle = await fs.open(file, 'r');
	return readHandle().finally(() => handle.close());

	async function readHandle(): Promise<JsonObject> {
		const before = await handle.stat();
		if (!before.isFile() || before.size > MAX_BYTES) throw new SessionError('too_large', 'Artifacts must be regular files no larger than 64 MiB.');
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
			throw new SessionError('read_failed', 'The artifact changed during the read. Retry after capture completes.');
		}
		const source = buffer.subarray(0, length).toString('utf8');
		if (!Buffer.from(source, 'utf8').equals(buffer.subarray(0, length))) {
			throw new SessionError('invalid_artifact', 'Artifact JSON must use valid UTF-8.');
		}
		// Parse first, then reject duplicate keys that JSON.parse would otherwise replace.
		const parsed: unknown = JSON.parse(source);
		const stack: Array<Set<string> | null> = [];
		const expectingKey: boolean[] = [];
		for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
			const token = match[0];
			if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); expectingKey.push(token === '{'); }
			else if (token === '}' || token === ']') { stack.pop(); expectingKey.pop(); }
			else if (token === ',' && stack[stack.length - 1]) expectingKey[stack.length - 1] = true;
			else if (token.startsWith('"') && expectingKey[stack.length - 1]) {
				const key: string = JSON.parse(token), keys = stack[stack.length - 1]!;
				if (keys.has(key)) throw new SessionError('invalid_artifact', 'Artifact JSON contains duplicate fields.');
				keys.add(key); expectingKey[stack.length - 1] = false;
			}
		}
		if (!object(parsed)) throw new SessionError('invalid_artifact', 'Artifact JSON must contain an object.');
		return parsed;
	}
}

function validateSession(value: JsonObject, id: string): void {
	if (!sessionRule(value) || value.id !== id || Date.parse(value.startedUtc as string) > Date.parse(value.capturedUtc as string)) {
		throw new SessionError('invalid_artifact', 'The session is incomplete, unsupported, or does not match the selected ID.');
	}
}

function validateTranscript(value: JsonObject, session: JsonObject): void {
	if (!transcriptRule(value) || value.sessionId !== session.id || value.startedUtc !== session.startedUtc || value.capturedUtc !== session.capturedUtc) {
		throw new SessionError('invalid_artifact', 'The transcript is incomplete or does not match the selected capture.');
	}
	const entries = value.entries as JsonObject[], groups = value.groups as Record<string, JsonObject>;
	const errors = Object.entries(groups).filter(([, item]) => ['error', 'exception', 'assert'].includes(item.type as string));
	const indices = new Set(entries.map(entry => entry.index));
	const grouped = new Map<string, JsonObject[]>();
	for (const entry of entries) {
		const key = entry.key as string;
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key)!.push(entry);
	}
	const errorGroups = value.errorGroups as Record<string, JsonObject>;
	const summaryFields = ['count', 'firstIndex', 'lastIndex', 'firstTimestampUtc', 'lastTimestampUtc'];
	if (value.entryCount !== entries.length || value.entryCount !== session.consoleEntryCount || indices.size !== entries.length
		|| value.groupCount !== Object.keys(groups).length || value.errorGroupCount !== errors.length
		|| value.errorGroupCount !== session.consoleErrorGroupCount || value.trimmed !== session.consoleTrimmed
		|| Object.keys(errorGroups).length !== errors.length || errors.some(([key]) => !Object.prototype.hasOwnProperty.call(errorGroups, key))
		|| entries.some((entry, index) => index > 0 && (entries[index - 1].index as number) >= (entry.index as number))
		|| entries.some(entry => !Object.prototype.hasOwnProperty.call(groups, entry.key as string) || groups[entry.key as string].type !== entry.type)
		|| Object.entries(groups).some(([key, item]) => {
			const selected = grouped.get(key) ?? [], timeline = item.timeline as JsonObject[];
			const first = selected[0], last = selected[selected.length - 1];
			return !first || item.key !== key || item.count !== selected.length || timeline.length !== selected.length
				|| item.firstIndex !== first.index || item.lastIndex !== last.index
				|| item.firstTimestampUtc !== first.timestampUtc || item.lastTimestampUtc !== last.timestampUtc
				|| timeline.some((point, index) => point.index !== selected[index].index
					|| point.timestampUtc !== selected[index].timestampUtc || point.elapsedMs !== selected[index].elapsedMs)
				|| (Object.prototype.hasOwnProperty.call(errorGroups, key) && summaryFields.some(field => errorGroups[key][field] !== item[field]));
		})) {
		throw new SessionError('invalid_artifact', 'Transcript counts, groups, or entry identities are inconsistent.');
	}
}

async function execute(argv: string[]): Promise<JsonObject> {
	const options = parseOptions(argv);
	const project = await fs.realpath(path.resolve(options.project));
	const directory = await fs.realpath(path.join(project, ...SESSION_ROOT, options.scope));
	if (!isWithin(project, directory) || !(await fs.stat(directory)).isDirectory()) {
		throw new SessionError('unsafe_path', 'Session storage must be a directory inside the selected project.');
	}
	if (options.action === 'list') {
		const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('.console.json')).sort();
		const sessions: JsonObject[] = [];
		for (const name of names) {
			const file = await artifactPath(directory, name), info = await fs.stat(file);
			sessions.push({ id: name.slice(0, -5), kind: options.scope, path: file, lastWriteUtc: info.mtime.toISOString(), bytes: info.size });
		}
		return { success: true, sessions };
	}
	const id = options.id!;
	const session = await readObject(await artifactPath(directory, id + '.json'));
	validateSession(session, id);
	if (options.action === 'read') return { success: true, session };
	// Persisted absolute paths are historical metadata, never read destinations.
	const consoleTranscript = await readObject(await artifactPath(directory, id + '.console.json'));
	validateTranscript(consoleTranscript, session);
	return { success: true, id, consoleTranscript };
}

if (process.argv.length === 3 && process.argv[2] === '--help') {
	process.stdout.write(USAGE);
} else {
	void Promise.resolve().then(() => execute(process.argv.slice(2))).then(result => {
		process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	}, (error: unknown) => {
		const systemCode = (error as NodeJS.ErrnoException)?.code;
		const failure = error instanceof SessionError ? error
			: error instanceof SyntaxError ? new SessionError('invalid_artifact', 'Artifact JSON is malformed.')
				: systemCode === 'ENOENT' ? new SessionError('not_found', 'The selected project, storage directory, or artifact does not exist.')
					: new SessionError('read_failed', 'The selected artifact could not be read. Check its permissions and capture state.');
		process.stderr.write(JSON.stringify({ success: false, error: { code: failure.code, message: failure.message } }) + '\n');
		process.exitCode = 1;
	});
}
