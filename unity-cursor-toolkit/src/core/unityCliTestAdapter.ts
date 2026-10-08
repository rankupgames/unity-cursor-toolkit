import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { redactUnityTestText as redact } from './unityTestPrivacy';
import * as crypto from 'crypto';
import { UnityCliAdapter, UnityCliResult } from './unityCliAdapter';
import { readUnityProjectVersion } from './unityEditorLauncher';
import { UnityTestCase, UnityTestFilters, UnityTestRequest, UnityTestSnapshot, UnityTestStatus } from './unityTestTypes';

// The locked parser is bundled by the existing build; no runtime VS Code imports.
const xmlParser = require('xml2js') as {
	parseStringPromise(xml: string, options: { strict: boolean; explicitArray: boolean; explicitRoot: boolean }): Promise<unknown>;
};
const REPORT_LIMIT = 8 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value != null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const escapeRegex = (value: string): string => value.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');


function empty(request: UnityTestRequest): UnityTestSnapshot {
	return { success: false, backend: 'cli', runId: 'cli-' + crypto.randomBytes(16).toString('hex'), status: 'error',
		editorVersion: '', mode: request?.mode === 'EditMode' || request?.mode === 'PlayMode' ? request.mode : null,
		selection: [], tests: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: 0 } };
}
function fail(snapshot: UnityTestSnapshot, code: string, message: string, recovery: string, native?: UnityCliResult): UnityTestSnapshot {
	snapshot.success = false;
	snapshot.status = code === 'cancelled' ? 'cancelled' : code === 'timed_out' ? 'timed_out' : code === 'tests_failed' ? 'failed' : 'error';
	snapshot.error = { code, message, recovery };
	if (native) {
		snapshot.error.exitCode = native.exitCode;
		if (!native.ok && native.error.nativeCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(native.error.nativeCode)
			&& redact(native.error.nativeCode, '') === native.error.nativeCode) { snapshot.error.nativeCode = native.error.nativeCode; }
	}
	return snapshot;
}
function nativeFailure(snapshot: UnityTestSnapshot, result: Extract<UnityCliResult, { ok: false }>): UnityTestSnapshot {
	// Raw streams/excerpts/native messages can contain credentials or arbitrary machine paths.
	return fail(snapshot, result.error.code, 'Unity CLI test operation failed (' + result.error.code + ').',
		result.error.code === 'tests_failed' ? 'Inspect the normalized test failures.'
			: result.error.code === 'cancelled' || result.error.code === 'timed_out' ? 'Inspect the interrupted run before retrying.'
			: 'Check the pinned CLI, exact Editor, and project state before retrying.', result);
}
function filterPattern(filters: UnityTestFilters | undefined): string | undefined {
	if (filters === undefined) { return undefined; }
	if (!record(filters)) { throw new Error('invalid_test_request'); }
	const keys = Object.keys(filters);
	if (keys.some(key => !['assembly', 'namespace', 'class', 'test', 'category'].includes(key))) { throw new Error('invalid_test_request'); }
	if (keys.some(key => typeof filters[key as keyof UnityTestFilters] !== 'string' || !filters[key as keyof UnityTestFilters]?.length
		|| /[\0\r\n]/.test(filters[key as keyof UnityTestFilters]!))) { throw new Error('invalid_test_request'); }
	if (filters.assembly || filters.category || Object.values(filters).some(value => value.includes(';'))) { throw new Error('capability_unavailable'); }
	const parts: string[] = [];
	if (filters.namespace) { parts.push(escapeRegex(filters.namespace) + '\\..+\\.[^.()]+(?:\\(.*\\))?'); }
	if (filters.class) { parts.push(escapeRegex(filters.class) + '\\.[^.()]+(?:\\(.*\\))?'); }
	if (filters.test) { parts.push(escapeRegex(filters.test)); }
	return parts.length ? '^' + parts.map(part => '(?=' + part + '$)').join('') + '.*$' : undefined;
}
function packageMetadata(projectPath: string, executable: string, packageId: string, manifest: RecordValue, lock: RecordValue): RecordValue | null {
	const dependency = record(record(lock.dependencies)?.[packageId]);
	const requested = record(manifest.dependencies)?.[packageId];
	if (!dependency || typeof dependency.version !== 'string' || typeof dependency.source !== 'string') { return null; }
	const candidates: string[] = [];
	if (dependency.source === 'builtin') {
		const data = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '..') : path.join(path.dirname(executable), 'Data');
		candidates.push(path.join(data, 'Resources', 'PackageManager', 'BuiltInPackages', packageId, 'package.json'));
	} else if (dependency.source === 'embedded') {
		candidates.push(path.join(projectPath, 'Packages', packageId, 'package.json'));
	} else if (dependency.source === 'local' && typeof requested === 'string' && requested.startsWith('file:')) {
		candidates.push(path.resolve(projectPath, 'Packages', requested.slice(5), 'package.json'));
	} else if (dependency.source === 'registry' && typeof dependency.url === 'string' && dependency.url.length > 0) {
		const cache = path.join(projectPath, 'Library', 'PackageCache');
		for (const entry of fs.readdirSync(cache)) {
			if (entry.startsWith(packageId + '@')) { candidates.push(path.join(cache, entry, 'package.json')); }
		}
	} else { return null; }
	const matches = candidates.map(file => {
		try { return record(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
	}).filter(pkg => pkg?.name === packageId && typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)
		&& (dependency.source !== 'registry' || pkg.version === dependency.version));
	return matches.length === 1 ? matches[0] : null;
}
function integer(value: unknown): number {
	if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) { throw new Error('Invalid count'); }
	return Number(value);
}
function duration(value: unknown): number {
	if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value) * 1000)) { throw new Error('Invalid duration'); }
	return Number(value) * 1000;
}
function text(value: unknown): string {
	if (value === undefined) { return ''; }
	if (!Array.isArray(value) || value.length !== 1) { throw new Error('Invalid text'); }
	if (typeof value[0] === 'string') { return value[0]; }
	const node = record(value[0]);
	if (node && typeof node._ === 'string' && Object.keys(node).every(key => key === '_' || key === '$')) { return node._; }
	throw new Error('Invalid text');
}
async function normalizeReport(xml: string, snapshot: UnityTestSnapshot, filters: UnityTestFilters | undefined, projectPath: string): Promise<boolean> {
	if (Buffer.byteLength(xml, 'utf8') > REPORT_LIMIT || /<!DOCTYPE|<!ENTITY/i.test(xml)) { throw new Error('Unsupported XML'); }
	const parsed = record(await xmlParser.parseStringPromise(xml, { strict: true, explicitArray: true, explicitRoot: true }));
	const root = record(parsed?.['test-run']);
	if (!root || !parsed || Object.keys(parsed).length !== 1) { throw new Error('Missing test-run'); }
	const attributes = record(root.$);
	if (!attributes) { throw new Error('Missing run metadata'); }
	const expected = { total: integer(attributes.total), passed: integer(attributes.passed), failed: integer(attributes.failed),
		skipped: integer(attributes.skipped), inconclusive: integer(attributes.inconclusive), notRun: attributes['not-run'] === undefined ? 0 : integer(attributes['not-run']) };
	const pending: { node: RecordValue; depth: number }[] = [{ node: root, depth: 0 }];
	const tests: UnityTestCase[] = [], ids = new Set<string>(), names = new Set<string>();
	const actual = { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0 };
	let cancelled = false;
	while (pending.length) {
		const current = pending.pop()!;
		if (current.depth > 100) { throw new Error('Excessive report nesting'); }
		for (const suite of current.node['test-suite'] as unknown[] ?? []) {
			const node = record(suite); if (!node) { throw new Error('Invalid suite'); }
			pending.push({ node, depth: current.depth + 1 });
		}
		for (const leaf of current.node['test-case'] as unknown[] ?? []) {
			const node = record(leaf), data = record(node?.$);
			if (!node || !data || typeof data.id !== 'string' || !data.id || typeof data.fullname !== 'string' || !data.fullname
				|| ids.has(data.id) || names.has(data.fullname)) { throw new Error('Invalid test identity'); }
			ids.add(data.id); names.add(data.fullname);
			const statuses: Record<string, UnityTestStatus> = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped', Inconclusive: 'inconclusive', NotRun: 'not_run', Cancelled: 'not_run', Canceled: 'not_run' };
			let status = typeof data.result === 'string' ? statuses[data.result] : undefined;
			if (!status) { throw new Error('Unknown result state'); }
			const isCancelled = data.result === 'Cancelled' || data.result === 'Canceled' || data.label === 'Cancelled' || data.label === 'Canceled';
			const counter = status === 'not_run' ? 'notRun' : status;
			actual[counter]++; actual.total++;
			if (isCancelled) { status = 'not_run'; cancelled = true; }
			if (filters?.test && data.fullname !== filters.test
				|| filters?.class && data.classname !== filters.class
				|| filters?.namespace && (typeof data.classname !== 'string' || !data.classname.startsWith(filters.namespace + '.'))) { throw new Error('Filter mismatch'); }
			if (node.failure !== undefined && (!Array.isArray(node.failure) || node.failure.length !== 1 || !record(node.failure[0]))
				|| node.reason !== undefined && (!Array.isArray(node.reason) || node.reason.length !== 1 || !record(node.reason[0]))) { throw new Error('Invalid failure metadata'); }
			const failure = (node.failure as unknown[] | undefined)?.[0], reason = (node.reason as unknown[] | undefined)?.[0];
			tests.push({ id: redact(data.id, projectPath), fullName: redact(data.fullname, projectPath), status, durationMs: duration(data.duration),
				message: redact(text(record(failure)?.message ?? record(reason)?.message), projectPath),
				stackTrace: redact(text(record(failure)?.['stack-trace']), projectPath) });
		}
	}
	if (Object.keys(expected).some(key => expected[key as keyof typeof expected] !== actual[key as keyof typeof actual])) { throw new Error('Inconsistent counts'); }
	if (typeof attributes.result !== 'string' || !['Passed', 'Failed', 'Failed(Child)', 'Skipped', 'Skipped:Ignored', 'Inconclusive', 'Cancelled', 'Canceled'].includes(attributes.result)) { throw new Error('Invalid run result'); }
	if (attributes.result === 'Cancelled' || attributes.result === 'Canceled' || attributes.label === 'Cancelled' || attributes.label === 'Canceled') { cancelled = true; }
	if ((attributes.result === 'Passed' && (actual.failed > 0 || cancelled)) || (attributes.result.startsWith('Failed') && actual.failed === 0 && !cancelled)) { throw new Error('Run/leaf mismatch'); }
	snapshot.tests = tests.sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0);
	snapshot.selection = snapshot.tests.map(test => test.fullName);
	snapshot.summary = { total: tests.length, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: duration(attributes.duration) };
	for (const test of tests) { snapshot.summary[test.status === 'not_run' ? 'notRun' : test.status]++; }
	return cancelled;
}

/** CLI test execution only. Discovery and dry-run require the bridge backend. */
export class UnityCliTestAdapter {
	public constructor(private readonly cli: UnityCliAdapter = new UnityCliAdapter()) {}

	public async listTests(request: UnityTestRequest): Promise<UnityTestSnapshot> {
		if (!request || (request.mode !== 'EditMode' && request.mode !== 'PlayMode')) { return fail(empty(request), 'invalid_test_request', 'A supported mode is required.', 'Provide EditMode or PlayMode.'); }
		return fail(empty(request), 'capability_unavailable', 'The pinned CLI cannot discover tests.', 'Use the bridge backend for test discovery.');
	}

	public async runTests(request: UnityTestRequest): Promise<UnityTestSnapshot> {
		const snapshot = empty(request);
		if (!request || !snapshot.mode || typeof request.projectPath !== 'string' || !request.projectPath || request.projectPath.includes('\0')
			|| !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647) {
			return fail(snapshot, 'invalid_test_request', 'A project path, supported mode and positive bounded timeout are required.', 'Provide a valid test request.');
		}
		if (request.dryRun || request.outputFormat !== undefined && request.outputFormat !== 'json') {
			return fail(snapshot, 'capability_unavailable', 'The CLI supports execution with JSON output, not discovery or a test dry-run.', 'Use the bridge backend for planning.');
		}
		let pattern: string | undefined;
		try { pattern = filterPattern(request.filters); } catch (error) {
			const code = (error as Error).message === 'capability_unavailable' ? 'capability_unavailable' : 'invalid_test_request';
			return fail(snapshot, code, code === 'capability_unavailable' ? 'The CLI cannot preserve the requested filter semantics.' : 'Test filters must be known nonempty literal strings.',
				'Use supported literal test, class or namespace filters, or select the bridge backend.');
		}
		const projectPath = path.resolve(request.projectPath), deadline = Date.now() + request.timeoutMs;
		snapshot.editorVersion = readUnityProjectVersion(projectPath) ?? '';
		if (!snapshot.editorVersion) { return fail(snapshot, 'invalid_project', 'The exact declared Editor version is unavailable.', 'Restore ProjectSettings/ProjectVersion.txt; no Editor fallback is used.'); }
		const interrupted = (): UnityTestSnapshot | undefined => request.signal?.aborted
			? fail(snapshot, 'cancelled', 'Test request was cancelled.', 'Retry when ready.')
			: Date.now() >= deadline ? fail(snapshot, 'timed_out', 'Test request exceeded its deadline.', 'Inspect the run before retrying.') : undefined;
		const checkState = (): void => {
			if (!fs.statSync(path.join(projectPath, 'Assets')).isDirectory()) { throw new Error('invalid_project'); }
			if (fs.existsSync(path.join(projectPath, 'Temp', 'UnityLockfile'))) { throw new Error('project_locked'); }
			if (readUnityProjectVersion(projectPath) !== snapshot.editorVersion) { throw new Error('invalid_project'); }
		};
		try { checkState(); } catch (error) {
			const code = (error as Error).message === 'project_locked' ? 'project_locked' : 'invalid_project';
			return fail(snapshot, code, 'Unity project is unavailable or already open.', 'Close the project normally or repair its metadata before starting a CLI run.');
		}
		let stopped = interrupted(); if (stopped) { return stopped; }
		const options = () => ({ timeoutMs: Math.max(1, deadline - Date.now()), signal: request.signal, readOnly: false });
		const probe = await this.cli.probe(options());
		if (!probe.ok) { return nativeFailure(snapshot, probe); }
		stopped = interrupted(); if (stopped) { return stopped; }
		const inventory = await this.cli.invoke('editors', ['-i'], options());
		if (!inventory.ok) { return nativeFailure(snapshot, inventory); }
		const rows = Array.isArray(inventory.data) ? inventory.data : record(inventory.data)?.editors;
		if (!Array.isArray(rows)) { return fail(snapshot, 'test_metadata_unavailable', 'Installed Editor metadata is invalid.', 'Inspect the pinned CLI Editor inventory.'); }
		const matches = rows.map(record).filter(row => row?.version === snapshot.editorVersion);
		if (matches.length === 0) { return fail(snapshot, 'missing_editor', 'The exact declared Editor is not installed.', 'Install that exact Editor before running tests.'); }
		const editor = matches.length === 1 ? matches[0] : null;
		if (!editor || typeof editor.location !== 'string' || !path.isAbsolute(editor.location) || typeof editor.modules !== 'string' || !['x86_64', 'arm64'].includes(String(editor.architecture))) {
			return fail(snapshot, 'test_metadata_unavailable', 'Exact Editor path, modules or architecture metadata is unavailable.', 'Repair the installed Editor inventory; no fallback is used.');
		}
		try {
			if (!fs.statSync(editor.location).isFile()) { throw new Error('Missing Editor executable'); }
			const manifest = record(JSON.parse(fs.readFileSync(path.join(projectPath, 'Packages', 'manifest.json'), 'utf8')));
			const lock = record(JSON.parse(fs.readFileSync(path.join(projectPath, 'Packages', 'packages-lock.json'), 'utf8')));
			if (!manifest || !record(manifest.dependencies) || !lock || !record(lock.dependencies) || !packageMetadata(projectPath, editor.location, 'com.unity.test-framework', manifest, lock)
				|| !packageMetadata(projectPath, editor.location, 'com.unity.ext.nunit', manifest, lock)) { throw new Error('Missing test package metadata'); }
			checkState();
		} catch (error) {
			return fail(snapshot, (error as Error).message === 'project_locked' ? 'project_locked' : 'missing_module',
				'The exact Editor or resolved test-framework/NUnit package metadata is unavailable.', 'Repair the project and required test packages; no installation or upgrade is performed.');
		}
		stopped = interrupted(); if (stopped) { return stopped; }
		request.onSelected?.(snapshot.editorVersion);
		stopped = interrupted(); if (stopped) { return stopped; }
		let directory: string | undefined;
		try {
			directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-cli-tests-'));
			const output = path.join(directory, 'results.xml'), remaining = Math.max(1, deadline - Date.now());
			const args = [projectPath, '--mode', snapshot.mode, '--editor-version', snapshot.editorVersion, '--editor-path', editor.location,
				'--architecture', String(editor.architecture), '--output', output, '--report-format', 'nunit', '--timeout', String(Math.max(1, Math.floor(remaining / 1000) - 1))];
			if (pattern) { args.push('--filter', pattern); }
			args.push('--', '-nographics');
			const result = await this.cli.invoke('test', args, { timeoutMs: remaining, signal: request.signal, readOnly: false });
			if (!result.ok && result.error.code !== 'tests_failed') { return nativeFailure(snapshot, result); }
			if (result.ok) {
				const data = record(result.data), reports = record(data?.reports);
				if (data?.projectPath !== projectPath || data.output !== output || reports?.nunit !== output) { throw new Error('Result provenance mismatch'); }
			}
			if (!fs.statSync(output).isFile() || fs.statSync(output).size > REPORT_LIMIT) { throw new Error('Missing or oversized report'); }
			const cancelled = await normalizeReport(fs.readFileSync(output, 'utf8'), snapshot, request.filters, projectPath);
			if (snapshot.summary.total === 0) { return fail(snapshot, 'no_tests', 'No tests matched the requested selection.', 'Check the mode and literal filters.'); }
			if (snapshot.summary.notRun > 0 && !cancelled) { throw new Error('Incomplete run'); }
			if (cancelled) { return fail(snapshot, 'cancelled', 'The test report contains cancelled results.', 'Inspect the interrupted tests before retrying.', result); }
			if ((result.ok && snapshot.summary.failed > 0) || (!result.ok && snapshot.summary.failed === 0 && snapshot.summary.inconclusive === 0)) { throw new Error('Native/report mismatch'); }
			if (!result.ok) { return nativeFailure(snapshot, result); }
			snapshot.success = true; snapshot.status = 'completed'; return snapshot;
		} catch {
			snapshot.tests = []; snapshot.selection = []; snapshot.summary = { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: 0 };
			return fail(snapshot, 'invalid_results', 'Unity CLI did not produce a complete consistent NUnit report.', 'Inspect the Editor and report; no partial result is treated as success.');
		} finally {
			if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('uct-cli-tests-')) {
				try { fs.rmSync(directory, { recursive: true, force: true }); } catch {
					fail(snapshot, 'cleanup_failed', 'The owned temporary test report could not be removed.', 'Remove the temporary report after checking the run.');
				}
			}
		}
	}
}
