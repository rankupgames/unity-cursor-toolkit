/**
 * Shared MCP metadata helpers for agent-facing tool descriptions.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import type { ToolAnnotations } from '../core/interfaces';

const MUTATING_TOOLS = {
	manage_asset: true,
	manage_component: true,
	manage_gameobject: true,
	manage_material: true,
	play_mode: true,
	execute_menu_item: true,
	editor_validation: true,
	game_command: true,
	build_trigger: true,
	clear_console: true,
	profiler_snapshot: true,
	unity_context: true
} as const;

const READ_ONLY_TOOLS = {
	project_info: true,
	screenshot: true,
	read_console: true,
	resolve_meta: true
} as const;

const READ_ONLY_ACTIONS: Record<string, readonly string[]> = {
	manage_scene: ['getHierarchy'],
	manage_gameobject: ['find'],
	manage_component: ['getProperties'],
	editor_validation: ['list', 'status'],
	game_command: ['list', 'status'],
	profiler_snapshot: ['current', 'listSessions', 'readSession', 'readConsoleTranscript', 'discoverCounters'],
	unity_context: ['query', 'read', 'summary']
};

const DEFAULT_ACTIONS: Record<string, string> = {
	editor_validation: 'sync_and_compile',
	game_command: 'list',
	profiler_snapshot: 'current',
	unity_context: 'summary'
};

const DESTRUCTIVE_ACTIONS: Record<string, readonly string[]> = {
	manage_asset: ['delete'],
	manage_gameobject: ['destroy'],
	profiler_snapshot: ['clearSessions']
};

export function withDryRunProperty(properties: Record<string, unknown>): Record<string, unknown> {
	return {
		...properties,
		dryRun: {
			type: 'boolean',
			description: 'When true, return the Unity command that would run without sending it to Unity.'
		}
	};
}

export function getToolAnnotations(toolName: string): ToolAnnotations {
	return {
		title: toToolTitle(toolName),
		readOnlyHint: isAlwaysReadOnlyTool(toolName),
		destructiveHint: canBeDestructiveTool(toolName),
		idempotentHint: isUsuallyIdempotentTool(toolName),
		openWorldHint: false
	};
}

export function isDryRun(args: Record<string, unknown>): boolean {
	return args.dryRun === true;
}

export function isMutatingToolCall(toolName: string, args: Record<string, unknown>): boolean {
	if (toolName === 'batch_execute') {
		const operations = args.operations;
		if (Array.isArray(operations)) {
			return operations.some((operation: unknown) => {
				if (typeof operation !== 'object' || operation == null) {
					return true;
				}
				const op = operation as { tool?: unknown; args?: unknown };
				return typeof op.tool !== 'string'
					|| typeof op.args !== 'object'
					|| op.args == null
					|| isMutatingToolCall(op.tool, op.args as Record<string, unknown>);
			});
		}
		return true;
	}

	if (isAlwaysReadOnlyTool(toolName)) {
		return false;
	}

	const readOnlyActions = READ_ONLY_ACTIONS[toolName];
	if (readOnlyActions) {
		const action = typeof args.action === 'string' ? args.action : DEFAULT_ACTIONS[toolName] ?? '';
		return readOnlyActions.includes(action) === false;
	}

	return (MUTATING_TOOLS as Record<string, boolean>)[toolName] === true;
}

export function isDestructiveToolCall(toolName: string, args: Record<string, unknown>): boolean {
	if (toolName === 'batch_execute') {
		const operations = args.operations;
		return Array.isArray(operations) && operations.some((operation: unknown) => {
			if (typeof operation !== 'object' || operation == null) {
				return false;
			}
			const op = operation as { tool?: unknown; args?: unknown };
			return typeof op.tool === 'string'
				&& typeof op.args === 'object'
				&& op.args != null
				&& isDestructiveToolCall(op.tool, op.args as Record<string, unknown>);
		});
	}

	const destructiveActions = DESTRUCTIVE_ACTIONS[toolName];
	if (destructiveActions == null) {
		return false;
	}

	const action = typeof args.action === 'string' ? args.action : '';
	return destructiveActions.includes(action);
}

function isAlwaysReadOnlyTool(toolName: string): boolean {
	return (READ_ONLY_TOOLS as Record<string, boolean>)[toolName] === true;
}

function canBeDestructiveTool(toolName: string): boolean {
	return toolName === 'manage_asset'
		|| toolName === 'manage_gameobject'
		|| toolName === 'batch_execute'
		|| toolName === 'clear_console'
		|| toolName === 'profiler_snapshot';
}

function isUsuallyIdempotentTool(toolName: string): boolean {
	return toolName === 'project_info'
		|| toolName === 'editor_validation'
		|| toolName === 'read_console'
		|| toolName === 'resolve_meta'
		|| toolName === 'unity_context';
}

function toToolTitle(toolName: string): string {
	return toolName
		.split('_')
		.map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
		.join(' ');
}
