/**
 * Tool Router -- collects IToolProvider registrations, routes tool calls
 * from the MCP server to the appropriate provider.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import type { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';

export class ToolRouter {

	private readonly providers: IToolProvider[] = [];

	public register(provider: IToolProvider): void {
		this.providers.push(provider);
	}

	public getToolDefinitions(): ToolDefinition[] {
		return this.providers.flatMap((p) => p.getTools());
	}

	public async routeToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		for (const provider of this.providers) {
			const tools = provider.getTools();
			if (tools.some((t) => t.name === name)) {
				return provider.handleToolCall(name, args);
			}
		}

		return {
			content: [{ type: 'text', text: `Unknown tool: ${name}. Available tools: ${this.getToolDefinitions().map((t) => t.name).join(', ')}` }],
			isError: true
		};
	}
}
