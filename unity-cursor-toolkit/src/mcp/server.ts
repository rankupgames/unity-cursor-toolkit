/**
 * Standalone MCP stdio server for Unity Cursor Toolkit.
 *
 * The VS Code extension has its own in-process modules. This entrypoint is
 * for MCP clients that launch a plain Node subprocess.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRouter } from './toolRouter';
import { UnityMcpTools } from './unityMcpTools';
import { StandaloneUnityConnection } from './standaloneConnection';
import { StandaloneConsoleMcpTools, StandaloneConsoleStore } from './standaloneConsole';
import { StandaloneProjectMcpTools } from './standaloneProjectTools';
import { UnityContextMcpTools } from './unityContextIndex';
import { ViewportStreamMcpTools } from './viewportStreamTools';
import { isDryRun, isMutatingToolCall } from './toolMetadata';
import type { ToolDefinition, ToolResult } from '../core/interfaces';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'unity-cursor-toolkit';
const READ_ONLY_ENV = 'UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY';

interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: unknown;
}

interface JsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: string | number | null;
	readonly result?: unknown;
	readonly error?: JsonRpcError;
}

interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

interface ToolCallParams {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

interface ResourceDefinition {
	readonly uri: string;
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly mimeType: string;
}

interface PromptDefinition {
	readonly name: string;
	readonly title: string;
	readonly description: string;
}

export interface StandaloneMcpRuntime {
	readonly router: ToolRouter;
	readonly connection: StandaloneUnityConnection;
	readonly consoleStore: StandaloneConsoleStore;
	readonly viewportTools: ViewportStreamMcpTools;
	readonly readOnly: boolean;
	handleRequest(request: JsonRpcRequest): Promise<unknown>;
	dispose(): void;
}

const RESOURCES: readonly ResourceDefinition[] = [
	{
		uri: 'unity://project/info',
		name: 'unity-project-info',
		title: 'Unity Project Info',
		description: 'Current Unity version, active scene, build target, platform, play mode state, and project path.',
		mimeType: 'application/json'
	},
	{
		uri: 'unity://scene/hierarchy',
		name: 'unity-scene-hierarchy',
		title: 'Unity Scene Hierarchy',
		description: 'Active scene hierarchy from Unity.',
		mimeType: 'application/json'
	},
	{
		uri: 'unity://console/recent',
		name: 'unity-console-recent',
		title: 'Recent Unity Console',
		description: 'Recent Unity console entries observed while this MCP server has been connected.',
		mimeType: 'text/plain'
	},
	{
		uri: 'unity://console/errors',
		name: 'unity-console-errors',
		title: 'Unity Console Errors',
		description: 'Recent Unity error and exception entries observed while this MCP server has been connected.',
		mimeType: 'text/plain'
	},
	{
		uri: 'unity://tools/catalog',
		name: 'unity-tool-catalog',
		title: 'Unity Tool Catalog',
		description: 'Agent-facing catalog of Unity Cursor Toolkit MCP tools and annotations.',
		mimeType: 'application/json'
	},
	{
		uri: 'unity://context/summary',
		name: 'unity-context-summary',
		title: 'Unity Context Summary',
		description: 'Compact summary from .umetacontext/index.json.',
		mimeType: 'application/json'
	}
];

const PROMPTS: readonly PromptDefinition[] = [
	{
		name: 'diagnose_unity_errors',
		title: 'Diagnose Unity Errors',
		description: 'Read recent console errors, inspect project info, and propose the smallest safe fix.'
	},
	{
		name: 'inspect_active_scene',
		title: 'Inspect Active Scene',
		description: 'Inspect project info and scene hierarchy before editing Unity objects.'
	},
	{
		name: 'prepare_build',
		title: 'Prepare Build',
		description: 'Check project state and console output before triggering a Unity build.'
	},
	{
		name: 'safe_scene_edit_plan',
		title: 'Safe Scene Edit Plan',
		description: 'Plan scene edits with read-only inspection before using mutating tools.'
	}
];

export function createStandaloneMcpRuntime(readOnly = isReadOnlyMode()): StandaloneMcpRuntime {
	const router = new ToolRouter();
	const connection = new StandaloneUnityConnection();
	const consoleStore = new StandaloneConsoleStore();
	const viewportTools = new ViewportStreamMcpTools(connection);

	connection.onMessage((message) => consoleStore.addFromUnityMessage(message));
	connection.onMessage((message) => viewportTools.handleUnityMessage(message));
	router.register(new UnityMcpTools(connection));
	router.register(new UnityContextMcpTools());
	router.register(viewportTools);
	router.register(new StandaloneConsoleMcpTools(consoleStore));
	router.register(new StandaloneProjectMcpTools());

	return {
		router,
		connection,
		consoleStore,
		viewportTools,
		readOnly,
		handleRequest: (request) => handleRequest(router, consoleStore, readOnly, request),
		dispose: () => {
			void viewportTools.dispose();
			connection.dispose();
		}
	};
}

export function startStdioServer(runtime = createStandaloneMcpRuntime()): void {
	let buffer = '';

	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			void handleLine(runtime, trimmed);
		}
	});

	process.stdin.on('end', () => runtime.dispose());
	process.on('SIGTERM', () => {
		runtime.dispose();
		process.exit(0);
	});
	process.on('SIGINT', () => {
		runtime.dispose();
		process.exit(0);
	});
}

async function handleLine(runtime: StandaloneMcpRuntime, line: string): Promise<void> {
	let request: JsonRpcRequest;
	try {
		request = JSON.parse(line) as JsonRpcRequest;
	} catch (error) {
		writeResponse({ jsonrpc: '2.0', id: null, error: toError(-32700, 'Parse error', getErrorMessage(error)) });
		return;
	}

	if (request.id == null) {
		return;
	}

	try {
		const result = await runtime.handleRequest(request);
		writeResponse({ jsonrpc: '2.0', id: request.id, result });
	} catch (error) {
		writeResponse({ jsonrpc: '2.0', id: request.id, error: toError(getErrorCode(error), getErrorMessage(error)) });
	}
}

async function handleRequest(
	router: ToolRouter,
	consoleStore: StandaloneConsoleStore,
	readOnly: boolean,
	request: JsonRpcRequest
): Promise<unknown> {
	switch (request.method) {
		case 'initialize':
			return buildInitializeResult(router.getToolDefinitions(), readOnly);
		case 'ping':
			return {};
		case 'tools/list':
			return { tools: router.getToolDefinitions() };
		case 'tools/call':
			return callTool(router, readOnly, parseToolCallParams(request.params));
		case 'resources/list':
			return { resources: RESOURCES };
		case 'resources/read':
			return readResource(router, consoleStore, parseResourceUri(request.params));
		case 'prompts/list':
			return { prompts: PROMPTS };
		case 'prompts/get':
			return getPrompt(parsePromptName(request.params));
		default:
			throw new MethodNotFoundError(`Unsupported MCP method: ${request.method ?? '(missing)'}`);
	}
}

async function callTool(router: ToolRouter, readOnly: boolean, params: ToolCallParams): Promise<ToolResult> {
	if (readOnly && isMutatingToolCall(params.name, params.arguments) && isDryRun(params.arguments) === false) {
		return {
			content: [{
				type: 'text',
				text: `Tool '${params.name}' is blocked because ${READ_ONLY_ENV}=1. Re-run with dryRun=true or disable read-only mode.`
			}],
			isError: true
		};
	}

	return router.routeToolCall(params.name, params.arguments);
}

async function readResource(
	router: ToolRouter,
	consoleStore: StandaloneConsoleStore,
	uri: string
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
	const definition = RESOURCES.find((resource) => resource.uri === uri);
	if (definition == null) {
		throw new InvalidParamsError(`Unknown resource URI: ${uri}`);
	}

	let text: string;
	switch (uri) {
		case 'unity://project/info':
			text = toolResultToText(await router.routeToolCall('project_info', {}));
			break;
		case 'unity://scene/hierarchy':
			text = toolResultToText(await router.routeToolCall('manage_scene', { action: 'getHierarchy' }));
			break;
		case 'unity://console/recent':
			text = consoleStore.toResourceText();
			break;
		case 'unity://console/errors':
			text = consoleStore.toResourceText('error');
			break;
		case 'unity://tools/catalog':
			text = JSON.stringify(router.getToolDefinitions().map(toCatalogEntry), null, 2);
			break;
		case 'unity://context/summary':
			text = toolResultToText(await router.routeToolCall('unity_context', { action: 'summary' }));
			break;
		default:
			throw new InvalidParamsError(`Unknown resource URI: ${uri}`);
	}

	return {
		contents: [{ uri, mimeType: definition.mimeType, text }]
	};
}

function getPrompt(name: string): {
	description: string;
	messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} {
	const prompt = PROMPTS.find((item) => item.name === name);
	if (prompt == null) {
		throw new InvalidParamsError(`Unknown prompt: ${name}`);
	}

	return {
		description: prompt.description,
		messages: [{
			role: 'user',
			content: {
				type: 'text',
				text: buildPromptText(prompt.name)
			}
		}]
	};
}

function buildInitializeResult(tools: readonly ToolDefinition[], readOnly: boolean): Record<string, unknown> {
	return {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {
			tools: { listChanged: false },
			resources: { listChanged: false },
			prompts: { listChanged: false },
			logging: {}
		},
		serverInfo: {
			name: SERVER_NAME,
			version: readPackageVersion()
		},
		instructions: [
			'Unity Cursor Toolkit exposes Unity Editor tools for AI agents.',
			'Connect Unity first by installing com.rankupgames.unity-cursor-toolkit and opening the project in Unity.',
			`Read-only mode is ${readOnly ? 'enabled' : 'disabled'} via ${READ_ONLY_ENV}.`,
			'Use project_info, read_console, and manage_scene/getHierarchy before mutating a scene.',
			'Use unity_context action=scan to refresh .umetacontext/index.json, then query/read/summary to avoid broad Unity asset fetches.',
			'Use profiler_snapshot action=current for session artifacts, then readConsoleTranscript with the returned session id when the compact console timeline is needed.',
			'Use viewport_stream action=start only when a graphics-capable Unity host is available; -nographics is for non-rendering batch workflows.',
			'Use dryRun=true on mutating tools to inspect normalized Unity commands without executing them.',
			`Available tools: ${tools.map((tool) => tool.name).join(', ')}.`
		].join(' ')
	};
}

function parseToolCallParams(params: unknown): ToolCallParams {
	if (typeof params !== 'object' || params == null) {
		throw new InvalidParamsError('tools/call params are required');
	}

	const record = params as Record<string, unknown>;
	if (typeof record.name !== 'string' || record.name.length === 0) {
		throw new InvalidParamsError('tools/call params.name is required');
	}

	const args = record.arguments;
	return {
		name: record.name,
		arguments: typeof args === 'object' && args != null
			? args as Record<string, unknown>
			: {}
	};
}

function parseResourceUri(params: unknown): string {
	if (typeof params !== 'object' || params == null) {
		throw new InvalidParamsError('resources/read params are required');
	}

	const uri = (params as Record<string, unknown>).uri;
	if (typeof uri !== 'string' || uri.length === 0) {
		throw new InvalidParamsError('resources/read params.uri is required');
	}

	return uri;
}

function parsePromptName(params: unknown): string {
	if (typeof params !== 'object' || params == null) {
		throw new InvalidParamsError('prompts/get params are required');
	}

	const name = (params as Record<string, unknown>).name;
	if (typeof name !== 'string' || name.length === 0) {
		throw new InvalidParamsError('prompts/get params.name is required');
	}

	return name;
}

function toolResultToText(result: ToolResult): string {
	const text = result.content.map((item) => item.text).join('\n');
	return result.isError ? JSON.stringify({ success: false, error: text }) : text;
}

function toCatalogEntry(tool: ToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		title: tool.title ?? tool.annotations?.title,
		description: tool.description,
		annotations: tool.annotations,
		inputSchema: tool.inputSchema
	};
}

function buildPromptText(name: string): string {
	switch (name) {
		case 'diagnose_unity_errors':
			return 'Use unity://console/errors and project_info first. For timeline reconstruction, call profiler_snapshot with action=current, then profiler_snapshot with action=readConsoleTranscript and the returned session id. Identify the most likely Unity error cause, propose the smallest fix, and avoid mutating tools unless the user asks.';
		case 'inspect_active_scene':
			return 'Read project_info and unity://scene/hierarchy. Summarize the active scene, important objects, and any missing context before proposing edits.';
		case 'prepare_build':
			return 'Read project_info and recent console output. When console timing matters, capture profiler_snapshot action=current and readConsoleTranscript for the compact grouped console timeline. If the project is clean, propose a build_trigger call with dryRun=true before executing a build.';
		case 'safe_scene_edit_plan':
			return 'Inspect the active scene with read-only tools, produce a step-by-step edit plan, then use dryRun=true for the first mutating tool call.';
		default:
			return 'Use Unity Cursor Toolkit read-only tools first, then ask before mutating project or scene state.';
	}
}

function readPackageVersion(): string {
	const packagePath = path.resolve(__dirname, '..', '..', 'package.json');
	try {
		const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
		return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

function isReadOnlyMode(): boolean {
	const value = process.env[READ_ONLY_ENV];
	return value === '1' || value === 'true';
}

function writeResponse(response: JsonRpcResponse): void {
	process.stdout.write(JSON.stringify(response) + '\n');
}

function toError(code: number, message: string, data?: unknown): JsonRpcError {
	return data == null ? { code, message } : { code, message, data };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): number {
	if (error instanceof InvalidParamsError) {
		return -32602;
	}
	if (error instanceof MethodNotFoundError) {
		return -32601;
	}
	return -32603;
}

class InvalidParamsError extends Error {}
class MethodNotFoundError extends Error {}

if (require.main === module) {
	const runtime = createStandaloneMcpRuntime();
	startStdioServer(runtime);
}
