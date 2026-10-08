/**
 * MCP tool routing with canonical origin names and legacy aliases.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */
import type { IToolProvider, ToolCallContext, ToolDefinition, ToolResult } from '../core/interfaces';
import { isDryRun, isMutatingToolCall, isToolCallClassified } from './toolMetadata';

interface RegisteredTool {
	readonly provider: IToolProvider;
	readonly localName: string;
	readonly origin: string;
	readonly definition: ToolDefinition;
}

export class ToolRouter {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly aliases = new Map<string, RegisteredTool[]>();

	constructor(private readonly readOnly = false) {}

	// Providers keep local tool names; registration assigns the advertised origin.
	public register(provider: IToolProvider, origin = 'toolkit'): void {
		if (typeof origin !== 'string' || origin.length > 126 || !/^[a-z][a-z0-9_-]*$/.test(origin)) {
			throw new Error('Invalid tool origin: ' + origin);
		}
		const pending = new Map<string, RegisteredTool>();
		for (const tool of provider.getTools()) {
			const canonicalName = origin + '.' + tool.name;
			if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tool.name) || canonicalName.length > 128) {
				throw new Error('Invalid canonical tool name: ' + canonicalName);
			}
			if (this.tools.has(canonicalName) || pending.has(canonicalName)) {
				throw new Error('Duplicate canonical tool: ' + canonicalName);
			}
			pending.set(canonicalName, {
				provider, localName: tool.name, origin,
				definition: { ...tool, name: canonicalName, _meta: { ...tool._meta, origin, canonicalName, aliases: [tool.name] } }
			});
		}
		for (const [canonicalName, tool] of pending) {
			this.tools.set(canonicalName, tool);
			this.aliases.set(tool.localName, [...(this.aliases.get(tool.localName) ?? []), tool]);
		}
	}

	public getToolDefinitions(): ToolDefinition[] {
		return [...this.tools.values()].map(tool => tool.definition);
	}

	public async routeToolCall(name: string, args: Record<string, unknown>, context?: ToolCallContext): Promise<ToolResult> {
		const exact = this.tools.get(name);
		const candidates = name.includes('.') ? [] : this.aliases.get(name) ?? [];
		const selected = exact ?? candidates.find(tool => tool.origin === 'toolkit') ?? (candidates.length === 1 ? candidates[0] : undefined);
		if (selected == null) {
			const ambiguous = candidates.length > 1;
			return this.failure(ambiguous ? 'ambiguous_tool' : 'unknown_tool',
				ambiguous ? 'Ambiguous tool: ' + name : 'Unknown tool: ' + name,
				(ambiguous ? candidates.map(tool => tool.definition.name) : [...this.tools.keys()]).sort());
		}
		const canonicalName = selected.definition.name;
		let result: ToolResult;
		if (this.readOnly && (!isToolCallClassified(canonicalName, args)
			|| (canonicalName !== 'toolkit.run_tests' && isMutatingToolCall(canonicalName, args) && !isDryRun(args)))) {
			result = this.failure('policy_refused',
				"Tool '" + canonicalName + "' (origin " + selected.origin + ") is blocked because UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY=1. Use a classified dryRun plan or disable read-only mode.");
		} else {
			result = await selected.provider.handleToolCall(selected.localName, args, context);
		}
		return { ...result, _meta: { ...result._meta, origin: selected.origin, canonicalName } };
	}

	private failure(code: string, message: string, candidates?: string[]): ToolResult {
		return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: {
			code, message, ...(candidates == null ? {} : { candidates })
		} }) }], isError: true };
	}
}
