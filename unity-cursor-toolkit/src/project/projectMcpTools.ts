/**
 * Project MCP Tools -- IToolProvider for resolve_meta.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import { MetaManager } from './metaManager';

export class ProjectMcpTools implements IToolProvider {

	public readonly toolGroupName = 'project';

	private readonly metaManager: MetaManager;

	constructor(metaManager: MetaManager) {
		this.metaManager = metaManager;
	}

	public getTools(): ToolDefinition[] {
		return [
			{
				name: 'resolve_meta',
				description: 'Read a Unity .meta file for an asset path. Returns the GUID and import settings.',
				inputSchema: {
					type: 'object',
					properties: {
						assetPath: {
							type: 'string',
							description: 'Asset path relative to project root (e.g. Assets/Scripts/Player.cs)'
						}
					},
					required: ['assetPath']
				}
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name === 'resolve_meta') {
			const assetPath = args.assetPath as string;
			if (assetPath == null || assetPath.length === 0) {
				return { content: [{ type: 'text', text: 'assetPath is required' }], isError: true };
			}

			const content = await this.metaManager.resolveMetaFile(assetPath);
			if (content == null) {
				return { content: [{ type: 'text', text: `No .meta file found for: ${assetPath}` }], isError: true };
			}

			return { content: [{ type: 'text', text: content }] };
		}

		return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
	}
}
