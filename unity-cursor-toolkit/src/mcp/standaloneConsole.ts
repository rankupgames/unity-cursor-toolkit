/**
 * Console store and MCP tools for the standalone MCP server.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import type { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import type { StandaloneUnityMessage } from './standaloneConnection';
import { getToolAnnotations } from './toolMetadata';

const MAX_ENTRIES = 1_000;
const DEFAULT_LIMIT = 50;

interface StandaloneConsoleEntry {
	readonly type: string;
	readonly message: string;
	readonly stackTrace: string;
	readonly timestamp: string;
}

export class StandaloneConsoleStore {

	private readonly entries: StandaloneConsoleEntry[] = [];

	public addFromUnityMessage(message: StandaloneUnityMessage): void {
		if (message.command !== 'consoleEntry') {
			return;
		}

		const payload = message.payload;
		const entry: StandaloneConsoleEntry = {
			type: normalizeLevel(payload.type),
			message: typeof payload.message === 'string' ? payload.message : '',
			stackTrace: typeof payload.stackTrace === 'string' ? payload.stackTrace : '',
			timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString()
		};

		this.entries.push(entry);
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		}
	}

	public read(options: { readonly level?: string; readonly search?: string; readonly limit?: number }): StandaloneConsoleEntry[] {
		const normalizedLevel = options.level ? normalizeLevel(options.level) : undefined;
		const search = options.search?.toLowerCase();
		const limit = normalizeLimit(options.limit);

		let entries = this.entries;
		if (normalizedLevel) {
			entries = entries.filter((entry) => entry.type === normalizedLevel);
		}
		if (search && search.length > 0) {
			entries = entries.filter((entry) =>
				entry.message.toLowerCase().includes(search)
				|| entry.stackTrace.toLowerCase().includes(search));
		}

		return entries.slice(-limit);
	}

	public clear(): void {
		this.entries.length = 0;
	}

	public toResourceText(level?: string): string {
		const entries = this.read({ level, limit: DEFAULT_LIMIT });
		return entries.length === 0
			? 'No console entries match the filter.'
			: formatEntries(entries);
	}
}

export class StandaloneConsoleMcpTools implements IToolProvider {

	public readonly toolGroupName = 'console';

	constructor(private readonly store: StandaloneConsoleStore) {}

	public getTools(): ToolDefinition[] {
		return [
			{
				name: 'read_console',
				title: 'Read Console',
				description: 'Fetch recent Unity console entries observed by this MCP server process.',
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
				},
				annotations: getToolAnnotations('read_console')
			},
			{
				name: 'clear_console',
				title: 'Clear Console Buffer',
				description: 'Clear console entries buffered by this MCP server process.',
				inputSchema: { type: 'object', properties: {} },
				annotations: getToolAnnotations('clear_console')
			}
		];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		switch (name) {
			case 'read_console': {
				const entries = this.store.read({
					level: typeof args.level === 'string' ? args.level : undefined,
					limit: typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT,
					search: typeof args.search === 'string' ? args.search : undefined
				});

				return {
					content: [{
						type: 'text',
						text: entries.length === 0
							? 'No console entries match the filter.'
							: `${entries.length} entries:\n\n${formatEntries(entries)}`
					}]
				};
			}
			case 'clear_console':
				this.store.clear();
				return { content: [{ type: 'text', text: 'Console buffer cleared.' }] };
			default:
				return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		}
	}
}

function normalizeLevel(value: unknown): string {
	const text = typeof value === 'string' ? value.toLowerCase() : 'log';
	switch (text) {
		case 'error':
		case 'warning':
		case 'exception':
		case 'assert':
			return text;
		default:
			return 'log';
	}
}

function normalizeLimit(value: number | undefined): number {
	if (value == null || Number.isFinite(value) === false) {
		return DEFAULT_LIMIT;
	}

	return Math.max(1, Math.min(Math.floor(value), MAX_ENTRIES));
}

function formatEntries(entries: readonly StandaloneConsoleEntry[]): string {
	return entries.map((entry) => {
		let line = `[${entry.type.toUpperCase()}] [${entry.timestamp}] ${entry.message}`;
		if (entry.stackTrace.length > 0) {
			line += '\n' + entry.stackTrace;
		}
		return line;
	}).join('\n\n');
}
