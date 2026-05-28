/**
 * MCP client configuration snippets for agent setup.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as path from 'path';

export const MCP_SERVER_NAME = 'unity-cursor-toolkit';

export interface McpClientConfigOptions {
	readonly serverPath: string;
	readonly projectPath?: string;
	readonly readOnly?: boolean;
}

export interface McpClientConfigSnippets {
	readonly cursorClaude: string;
	readonly vscode: string;
	readonly zed: string;
}

export function getMcpServerPath(extensionPath: string): string {
	return path.join(extensionPath, 'out', 'mcp', 'server.js');
}

export function createMcpClientConfigSnippets(options: McpClientConfigOptions): McpClientConfigSnippets {
	const env = createServerEnv(options);
	const server = {
		type: 'stdio',
		command: 'node',
		args: [options.serverPath],
		env
	};

	return {
		cursorClaude: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2),
		vscode: JSON.stringify({
			servers: {
				[MCP_SERVER_NAME]: {
					...server,
					sandboxEnabled: false
				}
			}
		}, null, 2),
		zed: JSON.stringify({
			context_servers: {
				[MCP_SERVER_NAME]: {
					command: server.command,
					args: server.args,
					env
				}
			}
		}, null, 2)
	};
}

export function createCombinedMcpConfigText(options: McpClientConfigOptions): string {
	const snippets = createMcpClientConfigSnippets(options);
	return [
		'Cursor, Claude Code, and other mcpServers clients:',
		'```json',
		snippets.cursorClaude,
		'```',
		'VS Code Copilot Agent mode .vscode/mcp.json:',
		'```json',
		snippets.vscode,
		'```',
		'Zed settings.json:',
		'```json',
		snippets.zed,
		'```'
	].join('\n');
}

function createServerEnv(options: McpClientConfigOptions): Record<string, string> {
	const env: Record<string, string> = {
		UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: options.readOnly ? '1' : '0'
	};

	if (options.projectPath) {
		env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = options.projectPath;
	}

	return env;
}
