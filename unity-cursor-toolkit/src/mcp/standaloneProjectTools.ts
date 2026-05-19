/**
 * Project MCP tools for the standalone MCP server.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import { getToolAnnotations } from './toolMetadata';

export class StandaloneProjectMcpTools implements IToolProvider {

	public readonly toolGroupName = 'project';

	constructor(private readonly projectRoot = resolveProjectRoot()) {}

	public getTools(): ToolDefinition[] {
		return [
			{
				name: 'resolve_meta',
				title: 'Resolve Meta',
				description: 'Read a Unity .meta file for an asset path relative to the Unity project root.',
				inputSchema: {
					type: 'object',
					properties: {
						assetPath: {
							type: 'string',
							description: 'Asset path relative to project root, for example Assets/Scripts/Player.cs'
						}
					},
					required: ['assetPath']
				},
				annotations: getToolAnnotations('resolve_meta')
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name !== 'resolve_meta') {
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		}

		const assetPath = args.assetPath;
		if (typeof assetPath !== 'string' || assetPath.trim().length === 0) {
			return { content: [{ type: 'text', text: 'assetPath is required' }], isError: true };
		}

		const metaPath = resolveMetaPath(this.projectRoot, assetPath);
		if (metaPath == null) {
			return { content: [{ type: 'text', text: 'assetPath must stay inside the Unity project root' }], isError: true };
		}

		try {
			const content = await fs.readFile(metaPath, 'utf8');
			return { content: [{ type: 'text', text: content }] };
		} catch {
			return { content: [{ type: 'text', text: `No .meta file found for: ${assetPath}` }], isError: true };
		}
	}
}

export function resolveProjectRoot(): string {
	return path.resolve(
		process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH
		?? process.env.CLAUDE_PROJECT_DIR
		?? process.cwd()
	);
}

export function resolveMetaPath(projectRoot: string, assetPath: string): string | null {
	if (path.isAbsolute(assetPath)) {
		return null;
	}

	const metaRelativePath = assetPath.endsWith('.meta') ? assetPath : `${assetPath}.meta`;
	const root = path.resolve(projectRoot);
	const candidate = path.resolve(root, metaRelativePath);
	const relative = path.relative(root, candidate);

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}

	return candidate;
}
