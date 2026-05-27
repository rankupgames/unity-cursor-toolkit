/**
 * Unity MCP Tools -- IToolProvider that proxies tool calls to Unity
 * over the TCP connection. Each tool sends a command to Unity's MCPBridge
 * and returns the result.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import type { IToolProvider, ICommandSender, ToolDefinition, ToolResult } from '../core/interfaces';
import { getToolAnnotations, isDryRun, isMutatingToolCall, withDryRunProperty } from './toolMetadata';

export class UnityMcpTools implements IToolProvider {

	public readonly toolGroupName = 'unity';

	private readonly commandSender: ICommandSender;

	constructor(commandSender: ICommandSender) {
		this.commandSender = commandSender;
	}

	public getTools(): ToolDefinition[] {
		return [
			{
				name: 'manage_scene',
				title: 'Manage Scene',
				description: 'Manage Unity scenes: get hierarchy, load, save, or create a scene.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['getHierarchy', 'load', 'save', 'create'] },
						scenePath: { type: 'string', description: 'Scene asset path (for load/create)' },
						path: { type: 'string', description: 'Alias for scenePath' }
					}),
					required: ['action']
				},
				annotations: getToolAnnotations('manage_scene')
			},
			{
				name: 'manage_gameobject',
				title: 'Manage GameObject',
				description: 'Create, find, destroy, or transform GameObjects in the active scene.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['create', 'find', 'destroy', 'setTransform', 'setParent'] },
						name: { type: 'string' },
						instanceId: { type: 'number' },
						position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
						rotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } } },
						scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
						parentName: { type: 'string' },
						parentInstanceId: { type: 'number' }
					}),
					required: ['action']
				},
				annotations: getToolAnnotations('manage_gameobject')
			},
			{
				name: 'manage_component',
				title: 'Manage Component',
				description: 'Add, remove, or inspect components on a GameObject.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['add', 'remove', 'getProperties', 'setProperty'] },
						gameObjectName: { type: 'string' },
						instanceId: { type: 'number' },
						componentType: { type: 'string' },
						propertyName: { type: 'string' },
						propertyValue: { type: 'string' }
					}),
					required: ['action', 'gameObjectName']
				},
				annotations: getToolAnnotations('manage_component')
			},
			{
				name: 'manage_asset',
				title: 'Manage Asset',
				description: 'Import, move, rename, delete, or refresh Unity assets.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['import', 'move', 'rename', 'delete', 'refresh'] },
						path: { type: 'string' },
						newPath: { type: 'string' },
						source: { type: 'string' },
						dest: { type: 'string' },
						newName: { type: 'string' }
					}),
					required: ['action']
				},
				annotations: getToolAnnotations('manage_asset')
			},
			{
				name: 'manage_material',
				title: 'Manage Material',
				description: 'Create materials or set material properties (color, float, texture).',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['create', 'setColor', 'setFloat', 'setTexture'] },
						path: { type: 'string' },
						propertyName: { type: 'string' },
						property: { type: 'string', description: 'Alias for propertyName' },
						color: { type: 'object', properties: { r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' }, a: { type: 'number' } } },
						value: { type: 'number' },
						texturePath: { type: 'string' }
					}),
					required: ['action']
				},
				annotations: getToolAnnotations('manage_material')
			},
			{
				name: 'play_mode',
				title: 'Play Mode',
				description: 'Control Unity play mode: enter, exit, pause, or step.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: { type: 'string', enum: ['enter', 'exit', 'pause', 'step'] }
					}),
					required: ['action']
				},
				annotations: getToolAnnotations('play_mode')
			},
			{
				name: 'execute_menu_item',
				title: 'Execute Menu Item',
				description: 'Execute any Unity menu command by its path (e.g. "Window/General/Console").',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						menuPath: { type: 'string', description: 'Full menu path' }
					}),
					required: ['menuPath']
				},
				annotations: getToolAnnotations('execute_menu_item')
			},
			{
				name: 'screenshot',
				title: 'Screenshot',
				description: 'Capture the current game or scene view. Returns the file path of the screenshot.',
				inputSchema: { type: 'object', properties: {} },
				annotations: getToolAnnotations('screenshot')
			},
			{
				name: 'project_info',
				title: 'Project Info',
				description: 'Get Unity project info: version, active scene, build target, platform, play mode state.',
				inputSchema: { type: 'object', properties: {} },
				annotations: getToolAnnotations('project_info')
			},
			{
				name: 'profiler_snapshot',
				title: 'Profiler Snapshot',
				description: 'Capture the current Unity profiler session plus a compact whole-console transcript artifact, list retained sessions, read the session or console transcript, save a session, clear temp sessions, or discover available counters.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						action: {
							type: 'string',
							enum: ['current', 'listSessions', 'readSession', 'readConsoleTranscript', 'saveSession', 'clearSessions', 'discoverCounters'],
							description: 'Profiler snapshot action. Defaults to current.'
						},
						sessionId: { type: 'string', description: 'Session id for readSession, readConsoleTranscript, or saveSession.' },
						id: { type: 'string', description: 'Alias for sessionId.' },
						includeConsole: { type: 'boolean', description: 'Include compact whole-console transcript artifact metadata and grouped error summary in current snapshots. Defaults to true.' },
						includeRaw: { type: 'boolean', description: 'Include raw frame arrays and full configured detail.' },
						includeSaved: { type: 'boolean', description: 'Include saved sessions when listing, or also clear saved sessions with clearSessions. Defaults to false.' },
						format: { type: 'string', enum: ['json', 'markdown'], description: 'Return current snapshot as JSON object or Markdown content.' },
						limit: { type: 'number', description: 'Maximum counters returned by discoverCounters.' }
					})
				},
				annotations: getToolAnnotations('profiler_snapshot')
			},
			{
				name: 'build_trigger',
				title: 'Build Trigger',
				description: 'Trigger a Unity build with specified settings.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						buildPath: { type: 'string', description: 'Output path for the build' },
						path: { type: 'string', description: 'Alias for buildPath' },
						buildTarget: { type: 'number', description: 'Unity BuildTarget enum value. Defaults to the active editor target.' },
						development: { type: 'boolean', description: 'Development build flag' }
					})
				},
				annotations: getToolAnnotations('build_trigger')
			},
			{
				name: 'batch_execute',
				title: 'Batch Execute',
				description: 'Execute multiple tool calls in sequence. If any fails, the batch stops.',
				inputSchema: {
					type: 'object',
					properties: withDryRunProperty({
						operations: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									tool: { type: 'string' },
									args: { type: 'object' }
								},
								required: ['tool', 'args']
							}
						}
					}),
					required: ['operations']
				},
				annotations: getToolAnnotations('batch_execute')
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name === 'batch_execute') {
			return this.handleBatchExecute(args);
		}

		const unityArgs = UnityMcpTools.normalizeToolArgs(name, args);
		if (isDryRun(args) && isMutatingToolCall(name, args)) {
			return UnityMcpTools.buildDryRunResult(name, unityArgs);
		}

		const result = await this.commandSender.request('mcpToolCall', { toolName: name, args: unityArgs });

		if (result == null) {
			return {
				content: [{ type: 'text', text: `Unity did not respond. Is the project connected and the MCPBridge installed?` }],
				isError: true
			};
		}

		const resultPayload = result.result;
		const resultText = typeof resultPayload === 'string'
			? resultPayload
			: JSON.stringify(resultPayload ?? result);
		const isError = result.error === true || UnityMcpTools.isUnityErrorResult(resultPayload);

		return {
			content: [{ type: 'text', text: resultText }],
			isError
		};
	}

	private static isUnityErrorResult(result: unknown): boolean {
		return typeof result === 'object'
			&& result != null
			&& (result as { success?: unknown }).success === false;
	}

	public static normalizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
		let normalized: Record<string, unknown>;
		switch (name) {
			case 'manage_scene':
				normalized = UnityMcpTools.normalizeSceneArgs(args);
				break;
			case 'manage_asset':
				normalized = UnityMcpTools.normalizeAssetArgs(args);
				break;
			case 'manage_material':
				normalized = UnityMcpTools.normalizeMaterialArgs(args);
				break;
			case 'manage_gameobject':
				normalized = UnityMcpTools.normalizeGameObjectArgs(args);
				break;
			case 'manage_component':
				normalized = UnityMcpTools.normalizeComponentArgs(args);
				break;
			case 'build_trigger':
				normalized = UnityMcpTools.withAlias(args, 'buildPath', 'path');
				break;
			case 'profiler_snapshot':
				normalized = UnityMcpTools.withAlias(args, 'sessionId', 'id');
				break;
			default:
				normalized = args;
				break;
		}
		return UnityMcpTools.stripControlArgs(normalized);
	}

	private static buildDryRunResult(name: string, args: Record<string, unknown>): ToolResult {
		return {
			content: [{
				type: 'text',
				text: JSON.stringify({
					success: true,
					dryRun: true,
					command: 'mcpToolCall',
					toolName: name,
					args
				})
			}]
		};
	}

	private static stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
		if (args.dryRun == null) {
			return args;
		}

		const normalized = { ...args };
		delete normalized.dryRun;
		return normalized;
	}

	private static normalizeSceneArgs(args: Record<string, unknown>): Record<string, unknown> {
		return UnityMcpTools.withAlias(args, 'scenePath', 'path');
	}

	private static normalizeAssetArgs(args: Record<string, unknown>): Record<string, unknown> {
		const normalized = { ...args };
		const action = String(normalized.action ?? '');
		if (normalized.newPath != null) {
			if (action === 'move') {
				normalized.source ??= normalized.path;
				normalized.dest ??= normalized.newPath;
			}
			if (action === 'rename') {
				normalized.newName ??= UnityMcpTools.basenameWithoutExtension(normalized.newPath);
			}
		}
		return normalized;
	}

	private static normalizeMaterialArgs(args: Record<string, unknown>): Record<string, unknown> {
		const normalized = UnityMcpTools.withAlias(args, 'propertyName', 'property');
		const color = UnityMcpTools.colorToArray(normalized.color);
		if (color) {
			normalized.color = color;
		}
		return normalized;
	}

	private static normalizeGameObjectArgs(args: Record<string, unknown>): Record<string, unknown> {
		const normalized = { ...args };
		const position = UnityMcpTools.vectorToArray(normalized.position, ['x', 'y', 'z']);
		const rotation = UnityMcpTools.vectorToArray(normalized.rotation, ['x', 'y', 'z', 'w'], [0, 0, 0, 1]);
		const scale = UnityMcpTools.vectorToArray(normalized.scale, ['x', 'y', 'z']);

		if (position) {
			normalized.position = position;
		}
		if (rotation) {
			normalized.rotation = rotation;
		}
		if (scale) {
			normalized.localScale = scale;
			delete normalized.scale;
		}

		return normalized;
	}

	private static normalizeComponentArgs(args: Record<string, unknown>): Record<string, unknown> {
		const normalized = UnityMcpTools.withAlias(args, 'gameObjectName', 'name');
		if (normalized.propertyName != null && normalized.propertyPath == null) {
			normalized.propertyPath = normalized.propertyName;
		}
		if (normalized.propertyValue != null) {
			const value = normalized.propertyValue;
			if (typeof value === 'number') {
				normalized.valueNumber = value;
			} else if (typeof value === 'boolean') {
				normalized.valueBool = value;
			} else {
				normalized.valueString = String(value);
			}
		}
		return normalized;
	}

	private static withAlias(args: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
		if (args[from] == null || args[to] != null) {
			return args;
		}
		return { ...args, [to]: args[from] };
	}

	private static vectorToArray(value: unknown, keys: string[], defaults?: number[]): number[] | null {
		if (Array.isArray(value)) {
			return value.map(Number);
		}
		if (typeof value !== 'object' || value == null) {
			return null;
		}

		const record = value as Record<string, unknown>;
		return keys.map((key, index) => UnityMcpTools.toNumber(record[key], defaults?.[index] ?? 0));
	}

	private static colorToArray(value: unknown): number[] | null {
		return UnityMcpTools.vectorToArray(value, ['r', 'g', 'b', 'a'], [0, 0, 0, 1]);
	}

	private static toNumber(value: unknown, fallback: number): number {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
		return fallback;
	}

	private static basenameWithoutExtension(value: unknown): string | undefined {
		if (typeof value !== 'string' || value.length === 0) {
			return undefined;
		}

		const fileName = value.split(/[\\/]/).pop();
		if (fileName == null || fileName.length === 0) {
			return undefined;
		}

		const lastDot = fileName.lastIndexOf('.');
		return lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
	}

	private async handleBatchExecute(args: Record<string, unknown>): Promise<ToolResult> {
		const operations = args.operations as Array<{ tool: string; args: Record<string, unknown> }>;
		if (operations == null || operations.length === 0) {
			return { content: [{ type: 'text', text: 'No operations provided.' }], isError: true };
		}

		if (isDryRun(args) && isMutatingToolCall('batch_execute', args)) {
			return UnityMcpTools.buildDryRunResult('batch_execute', {
				operations: operations.map((op) => ({
					tool: op.tool,
					args: UnityMcpTools.normalizeToolArgs(op.tool, op.args)
				}))
			});
		}

		const results: string[] = [];

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			const result = await this.handleToolCall(op.tool, op.args);

			if (result.isError) {
				results.push(`[${i + 1}/${operations.length}] ${op.tool}: FAILED - ${result.content[0]?.text}`);
				results.push(`Batch stopped at operation ${i + 1}.`);
				return { content: [{ type: 'text', text: results.join('\n') }], isError: true };
			}

			results.push(`[${i + 1}/${operations.length}] ${op.tool}: ${result.content[0]?.text}`);
		}

		return { content: [{ type: 'text', text: results.join('\n') }] };
	}
}
