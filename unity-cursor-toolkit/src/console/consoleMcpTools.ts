/**
 * Console MCP Tools -- IToolProvider for read_console and clear_console.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import { ConsoleBridge } from './consoleBridge';

export class ConsoleMcpTools implements IToolProvider {

	public readonly toolGroupName = 'console';

	private readonly bridge: ConsoleBridge;

	constructor(bridge: ConsoleBridge) {
		this.bridge = bridge;
	}

	public getTools(): ToolDefinition[] {
		return [
			{
				name: 'read_console',
				description: 'Fetch recent Unity console log entries with optional filtering by level, search term, and limit.',
				inputSchema: {
					type: 'object',
					properties: {
						level: {
							type: 'string',
							enum: ['error', 'warning', 'log', 'exception', 'assert'],
							description: 'Filter by log level'
						},
						limit: {
							type: 'number',
							description: 'Maximum entries to return (default: 50)'
						},
						search: {
							type: 'string',
							description: 'Substring to search for in message or stack trace'
						}
					}
				}
			},
			{
				name: 'clear_console',
				description: 'Clear all Unity console entries.',
				inputSchema: { type: 'object', properties: {} }
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		switch (name) {
			case 'read_console': {
				const entries = this.bridge.getEntries({
					level: args.level as string | undefined,
					limit: (args.limit as number) ?? 50,
					search: args.search as string | undefined
				});

				const formatted = entries.map((e) => {
					let line = `[${e.type.toUpperCase()}] [${e.timestamp}] ${e.message}`;
					if (e.stackTrace) {
						line += '\n' + e.stackTrace;
					}
					return line;
				}).join('\n\n');

				return {
					content: [{
						type: 'text',
						text: entries.length === 0
							? 'No console entries match the filter.'
							: `${entries.length} entries:\n\n${formatted}`
					}]
				};
			}

			case 'clear_console': {
				this.bridge.clearEntries();
				return {
					content: [{ type: 'text', text: 'Console cleared.' }]
				};
			}

			default:
				return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		}
	}
}
