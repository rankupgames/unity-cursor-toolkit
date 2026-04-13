/**
 * Unity MCP Tools -- IToolProvider that proxies tool calls to Unity
 * over the TCP connection. Each tool sends a command to Unity's MCPBridge
 * and returns the result.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import { IToolProvider, ICommandSender, ToolDefinition, ToolResult } from '../core/interfaces';

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
				description: 'Manage Unity scenes: get hierarchy, load, save, or create a scene.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['getHierarchy', 'load', 'save', 'create'] },
						scenePath: { type: 'string', description: 'Scene asset path (for load/create)' }
					},
					required: ['action']
				}
			},
			{
				name: 'manage_gameobject',
				description: 'Create, find, destroy, or transform GameObjects in the active scene.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['create', 'find', 'destroy', 'setTransform', 'setParent'] },
						name: { type: 'string' },
						position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
						rotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
						scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
						parentName: { type: 'string' }
					},
					required: ['action']
				}
			},
			{
				name: 'manage_component',
				description: 'Add, remove, or inspect components on a GameObject.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['add', 'remove', 'getProperties', 'setProperty'] },
						gameObjectName: { type: 'string' },
						componentType: { type: 'string' },
						propertyName: { type: 'string' },
						propertyValue: { type: 'string' }
					},
					required: ['action', 'gameObjectName']
				}
			},
			{
				name: 'manage_asset',
				description: 'Import, move, rename, delete, or refresh Unity assets.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['import', 'move', 'rename', 'delete', 'refresh'] },
						path: { type: 'string' },
						newPath: { type: 'string' }
					},
					required: ['action']
				}
			},
			{
				name: 'manage_material',
				description: 'Create materials or set material properties (color, float, texture).',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['create', 'setColor', 'setFloat', 'setTexture'] },
						path: { type: 'string' },
						propertyName: { type: 'string' },
						color: { type: 'object', properties: { r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' }, a: { type: 'number' } } },
						value: { type: 'number' },
						texturePath: { type: 'string' }
					},
					required: ['action']
				}
			},
			{
				name: 'play_mode',
				description: 'Control Unity play mode: enter, exit, pause, or step.',
				inputSchema: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['enter', 'exit', 'pause', 'step'] }
					},
					required: ['action']
				}
			},
			{
				name: 'execute_menu_item',
				description: 'Execute any Unity menu command by its path (e.g. "Window/General/Console").',
				inputSchema: {
					type: 'object',
					properties: {
						menuPath: { type: 'string', description: 'Full menu path' }
					},
					required: ['menuPath']
				}
			},
			{
				name: 'screenshot',
				description: 'Capture the current game or scene view. Returns the file path of the screenshot.',
				inputSchema: { type: 'object', properties: {} }
			},
			{
				name: 'project_info',
				description: 'Get Unity project info: version, active scene, build target, platform, play mode state.',
				inputSchema: { type: 'object', properties: {} }
			},
			{
				name: 'build_trigger',
				description: 'Trigger a Unity build with specified settings.',
				inputSchema: {
					type: 'object',
					properties: {
						buildPath: { type: 'string', description: 'Output path for the build' },
						development: { type: 'boolean', description: 'Development build flag' }
					}
				}
			},
			{
				name: 'batch_execute',
				description: 'Execute multiple tool calls in sequence. If any fails, the batch stops.',
				inputSchema: {
					type: 'object',
					properties: {
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
					},
					required: ['operations']
				}
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name === 'batch_execute') {
			return this.handleBatchExecute(args);
		}

		const result = await this.commandSender.request('mcpToolCall', { toolName: name, args });

		if (result == null) {
			return {
				content: [{ type: 'text', text: `Unity did not respond. Is the project connected and the MCPBridge installed?` }],
				isError: true
			};
		}

		const resultText = (result.result as string) ?? JSON.stringify(result);
		const isError = result.error === true;

		return {
			content: [{ type: 'text', text: resultText }],
			isError
		};
	}

	private async handleBatchExecute(args: Record<string, unknown>): Promise<ToolResult> {
		const operations = args.operations as Array<{ tool: string; args: Record<string, unknown> }>;
		if (operations == null || operations.length === 0) {
			return { content: [{ type: 'text', text: 'No operations provided.' }], isError: true };
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
