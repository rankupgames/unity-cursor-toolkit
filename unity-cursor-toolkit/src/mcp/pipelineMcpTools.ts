import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { IToolProvider, ToolCallContext, ToolDefinition, ToolResult } from '../core/interfaces';
import { UnityCliAdapter, UNITY_CLI_EXPECTED_VERSION } from '../core/unityCliAdapter';
import type { UnityCliResult } from '../core/unityCliAdapter';
import { readUnityProjectVersion } from '../core/unityEditorLauncher';
import { PipelineAudit, PipelineAuditError, normalizePipelineNativeCode } from '../core/pipelineAudit';
import type { PipelineAuditClassification, PipelineAuditCompletion } from '../core/pipelineAudit';
import policy = require('../core/pipelinePolicy.json');

export const PIPELINE_COMMAND_NAMES = policy.commands.map(command => command.name);
const PACKAGE_ID = 'com.unity.pipeline';
const MAX_BYTES = 1024 * 1024;
const REVIEWED = new Map(policy.commands.map(command => [command.name, command]));
type ObjectValue = Record<string, unknown>;
type Metadata = { projectPath: string; editorVersion: string; fingerprint: string };
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;

function classification(command: unknown): PipelineAuditClassification {
	const risk = typeof command === 'string' ? REVIEWED.get(command)?.risk : undefined;
	return risk === 'read-only' ? 'read_only' : risk === 'policy-escape' ? 'escape'
		: risk === 'mutating' || risk === 'destructive' ? risk : 'unknown';
}
function text(payload: ObjectValue): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(payload.success === false ? { isError: true } : {}) };
}
function refuse(code: string, message: string, details: ObjectValue = {}): PipelineAuditCompletion<ToolResult> {
	return { value: text({ success: false, origin: 'pipeline', executionEligible: false, executed: false, ...details,
		error: { code, message } }), outcome: 'refused', code };
}
function readBounded(file: string): string {
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > MAX_BYTES) { throw new Error('Invalid metadata'); }
	return fs.readFileSync(file, 'utf8');
}
function metadata(projectPath: string): Metadata {
	const root = fs.realpathSync(projectPath);
	if (!fs.statSync(path.join(root, 'Assets')).isDirectory()) { throw new Error('Invalid project'); }
	const versionText = readBounded(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'));
	const editorVersion = readUnityProjectVersion(root);
	if (!editorVersion || Number(editorVersion.split('.')[0]) < 6000) { throw new Error('Invalid Editor version'); }
	const manifestText = readBounded(path.join(root, 'Packages', 'manifest.json'));
	const lockText = readBounded(path.join(root, 'Packages', 'packages-lock.json'));
	const manifest = object(JSON.parse(manifestText));
	const lock = object(JSON.parse(lockText));
	const requested = object(manifest?.dependencies)?.[PACKAGE_ID];
	const dependency = object(object(lock?.dependencies)?.[PACKAGE_ID]);
	if (requested !== policy.pipelineVersion || dependency?.version !== policy.pipelineVersion
		|| dependency?.source !== 'registry' || dependency?.depth !== 0 || dependency?.url !== 'https://packages.unity.com'
		|| fs.existsSync(path.join(root, 'Packages', PACKAGE_ID))) { throw new Error('pipeline_pin_mismatch'); }
	const cache = path.join(root, 'Library', 'PackageCache');
	const candidates = fs.readdirSync(cache).filter(name => name.startsWith(PACKAGE_ID + '@'));
	const matches: string[] = [];
	for (const candidate of candidates) {
		const packageText = readBounded(path.join(cache, candidate, 'package.json'));
		const pkg = object(JSON.parse(packageText));
		if (pkg?.name === PACKAGE_ID && pkg.version === policy.pipelineVersion) { matches.push(packageText); }
	}
	if (matches.length !== 1) { throw new Error('pipeline_pin_mismatch'); }
	return { projectPath: root, editorVersion,
		fingerprint: createHash('sha256').update(versionText).update(manifestText).update(lockText).update(matches[0]).digest('hex') };
}
function samePath(candidate: unknown, expected: string): boolean {
	if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) { return false; }
	try {
		const actual = fs.realpathSync(candidate);
		return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
	} catch { return false; }
}
function catalog(data: unknown, port: number): ObjectValue[] | null {
	const value = object(data), target = object(value?.target);
	if (!value || !target || target.host !== '127.0.0.1' || target.port !== port
		|| !Array.isArray(value.tools) || value.tools.length > 512 || value.count !== value.tools.length) { return null; }
	try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) { return null; } } catch { return null; }
	const names = new Set<string>();
	const tools: ObjectValue[] = [];
	for (const entry of value.tools) {
		const tool = object(entry);
		if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool.name)
			|| names.has(tool.name) || typeof tool.description !== 'string' || tool.description.length > 8192
			|| typeof tool.group !== 'string' || tool.group.length > 128 || !Array.isArray(tool.parameters) || tool.parameters.length > 128) { return null; }
		names.add(tool.name);
		const parameters: ObjectValue[] = [], parameterNames = new Set<string>();
		for (const entry of tool.parameters) {
			const parameter = object(entry);
			if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(parameter.name)
				|| parameterNames.has(parameter.name) || typeof parameter.type !== 'string' || parameter.type.length > 128
				|| typeof parameter.required !== 'boolean' || typeof parameter.description !== 'string' || parameter.description.length > 8192
				|| !Object.prototype.hasOwnProperty.call(parameter, 'default')) { return null; }
			parameterNames.add(parameter.name);
			parameters.push({ name: parameter.name, type: parameter.type, required: parameter.required,
				description: parameter.description, default: parameter.default });
		}
		const reviewed = REVIEWED.get(tool.name), risk = classification(tool.name);
		tools.push({ name: tool.name, description: tool.description, group: tool.group, schema: { parameters },
			classification: risk, classificationEvidence: reviewed ? 'reviewed SDK implementation; runtime handler unverified' : 'unreviewed runtime handler',
			...(reviewed ? { reviewedSource: reviewed.source, rationale: reviewed.rationale } : {}),
			executionEligible: false, reason: risk === 'unknown' ? 'unknown_command' : risk === 'read_only' ? 'provenance_unverified' : 'policy_refused' });
	}
	return tools;
}

/** Discovery and local policy plans only. No Pipeline command dispatch path exists. */
export class PipelineMcpTools implements IToolProvider {
	readonly toolGroupName = 'Pipeline';
	constructor(private readonly adapter: Pick<UnityCliAdapter, 'probe' | 'invoke'> = new UnityCliAdapter(),
		private readonly audit = new PipelineAudit(process.env.UNITY_CURSOR_TOOLKIT_PIPELINE_AUDIT_PATH, PIPELINE_COMMAND_NAMES)) {}

	getTools(): ToolDefinition[] {
		return [{ name: 'commands', description: 'Discover commands from the exact pinned Pipeline project and Editor. Run requests are classified and refused because handler provenance is unverified; dryRun plans stay local.',
			inputSchema: { type: 'object', additionalProperties: false, properties: {
				action: { type: 'string', enum: ['list', 'run'] }, projectPath: { type: 'string', description: 'Absolute Unity project path.' },
				editorPid: { type: 'integer', minimum: 1 }, command: { type: 'string' }, args: { type: 'object' },
				dryRun: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }
			}, required: ['action', 'projectPath', 'editorPid'] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }];
	}

	async handleToolCall(name: string, args: Record<string, unknown>, context?: ToolCallContext): Promise<ToolResult> {
		const request = object(args), risk = request?.action === 'list' ? 'read_only' : classification(request?.command);
		try {
			return await this.audit.withInvocation({ action: request?.dryRun === true ? 'plan' : request?.action === 'list' ? 'list' : 'run',
				command: typeof request?.command === 'string' ? request.command : undefined, classification: risk }, async () => {
				const completed = await this.handle(name, request, context);
				return { ...completed, classification: risk };
			});
		} catch (error) {
			return refuse(error instanceof PipelineAuditError ? error.code : 'backend_error',
				'Pipeline invocation could not finish. Check the explicit audit file and pinned CLI; no alternate backend is used.').value;
		}
	}

	private async handle(name: string, args: ObjectValue | null, context?: ToolCallContext): Promise<PipelineAuditCompletion<ToolResult>> {
		if (name !== 'commands' && name !== 'pipeline.commands') { return refuse('unknown_tool', 'Unknown Pipeline tool.'); }
		if (!args || Object.keys(args).some(key => !['action', 'projectPath', 'editorPid', 'command', 'args', 'dryRun', 'timeoutMs'].includes(key))
			|| typeof args.action !== 'string' || !['list', 'run'].includes(args.action) || typeof args.projectPath !== 'string' || !path.isAbsolute(args.projectPath)
			|| /[\0\r\n]/.test(args.projectPath) || !Number.isSafeInteger(args.editorPid) || (args.editorPid as number) <= 0
			|| (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
			|| (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || (args.timeoutMs as number) < 1 || (args.timeoutMs as number) > 120000))
			|| (args.command !== undefined && (typeof args.command !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(args.command)))
			|| (args.args !== undefined && !object(args.args)) || (args.action === 'run' && !args.command)
			|| (args.action === 'list' && (args.command !== undefined || args.args !== undefined))) {
			return refuse('invalid_arguments', 'Provide the approved action, absolute project path, positive Editor PID, and bounded arguments.');
		}
		try { if (args.args !== undefined && Buffer.byteLength(JSON.stringify(args.args)) > 65536) { throw new Error('Bound'); } }
		catch { return refuse('invalid_arguments', 'Command arguments must be a bounded JSON object.'); }
		if (context?.signal?.aborted) { return refuse('cancelled', 'Pipeline invocation was cancelled before backend traffic.'); }
		let local: Metadata;
		try { local = metadata(args.projectPath); }
		catch (error) { return refuse((error as Error).message === 'pipeline_pin_mismatch' ? 'pipeline_pin_mismatch' : 'project_metadata_invalid',
			'Project version, manifest, lock, and one resolved official Pipeline package must match the reviewed pin.'); }
		const details = { action: args.action, dryRun: args.dryRun === true, projectPath: local.projectPath,
			editorPid: args.editorPid, editorVersion: local.editorVersion, cliVersion: policy.cliVersion, pipelineVersion: policy.pipelineVersion };
		if (args.action === 'run') {
			const risk = classification(args.command), code = risk === 'unknown' ? 'unknown_command' : risk === 'read_only' ? 'provenance_unverified' : 'policy_refused';
			return { ...refuse(code, risk === 'read_only' ? 'The pinned catalog does not attest the selected handler. Execution is disabled.'
				: risk === 'unknown' ? 'This command has no reviewed SDK classification.' : 'This reviewed command class is refused by Pipeline policy.',
				{ ...details, command: args.command, classification: risk, targetVerified: false }) };
		}
		if (args.dryRun === true) {
			return { value: text({ success: true, origin: 'pipeline', ...details, executed: false, targetVerified: false,
				executionEligible: false, reason: 'provenance_unverified', plan: ['probe pinned CLI', 'verify exact project, PID and Editor version', 'list catalog from verified port'] }),
				outcome: 'success', code: 'ok' };
		}
		const deadline = Date.now() + (typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000);
		const options = () => ({ readOnly: true, cwd: local.projectPath, signal: context?.signal, timeoutMs: deadline - Date.now() });
		const interrupted = (): PipelineAuditCompletion<ToolResult> | undefined => context?.signal?.aborted
			? refuse('cancelled', 'Pipeline invocation was cancelled before the next diagnostic.', details)
			: Date.now() >= deadline ? refuse('timed_out', 'Pipeline discovery exceeded its total deadline.', details) : undefined;
		const nativeFailure = (result: Extract<UnityCliResult, { ok: false }>): PipelineAuditCompletion<ToolResult> => {
			const nativeCode = normalizePipelineNativeCode(result.error.nativeCode);
			const exitCode = result.exitCode ?? undefined;
			return { value: text({ success: false, origin: 'pipeline', executionEligible: false, executed: false, ...details,
				error: { code: result.error.code, message: 'Pinned CLI diagnostic failed (' + result.error.code + '); no fallback is used.', nativeCode, exitCode } }),
				outcome: 'failure', code: result.error.code, nativeCode, exitCode };
		};
		{ const stopped = interrupted(); if (stopped) { return stopped; } }
		const probe = await this.adapter.probe(options());
		if (!probe.ok) { return nativeFailure(probe); }
		if (probe.data.version !== UNITY_CLI_EXPECTED_VERSION || probe.data.version !== policy.cliVersion) { return refuse('version_mismatch', 'CLI probe must match the reviewed exact version.', details); }
		{ const stopped = interrupted(); if (stopped) { return stopped; } }
		const before = await this.adapter.invoke('status', ['--project-path', local.projectPath], options());
		if (!before.ok) { return nativeFailure(before); }
		const port = this.targetPort(before.data, local, args.editorPid as number);
		if (port === null) { return refuse('target_unverified', 'CLI status did not prove one exact ready project, PID and Editor version.', details); }
		{ const stopped = interrupted(); if (stopped) { return stopped; } }
		const listed = await this.adapter.invoke('list', ['--project-path', local.projectPath], options());
		if (!listed.ok) { return nativeFailure(listed); }
		const tools = catalog(listed.data, port);
		if (!tools) { return refuse('invalid_catalog', 'The bounded command catalog must have unique names and schemas from the verified loopback port.', details); }
		{ const stopped = interrupted(); if (stopped) { return stopped; } }
		const after = await this.adapter.invoke('status', ['--project-path', local.projectPath], options());
		if (!after.ok) { return nativeFailure(after); }
		try {
			if (this.targetPort(after.data, local, args.editorPid as number) !== port || metadata(local.projectPath).fingerprint !== local.fingerprint) {
				return refuse('target_unverified', 'Project metadata or Editor identity changed during discovery.', details);
			}
		} catch { return refuse('target_unverified', 'Project metadata changed during discovery.', details); }
		{ const stopped = interrupted(); if (stopped) { return stopped; } }
		return { value: text({ success: true, origin: 'pipeline', ...details, targetVerified: true, executionEligible: false,
			reason: 'provenance_unverified', commands: tools, count: tools.length }), outcome: 'success', code: 'ok',
			editorVersion: local.editorVersion, editorPid: args.editorPid as number, exitCode: listed.exitCode ?? undefined };
	}

	private targetPort(data: unknown, local: Metadata, pid: number): number | null {
		// beta.12 status filters by substring; list can choose a different match unless identity is unique.
		const status = object(data);
		if (status?.count !== 1 || !Array.isArray(status.instances) || status.instances.length !== 1) { return null; }
		const instance = object(status.instances[0]);
		return instance?.pid === pid && instance.version === local.editorVersion && instance.state === 'ready'
			&& samePath(instance.project, local.projectPath) && Number.isInteger(instance.port)
			&& (instance.port as number) > 0 && (instance.port as number) <= 65535 ? instance.port as number : null;
	}
}
