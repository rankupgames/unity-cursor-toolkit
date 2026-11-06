/**
 * MCP Module -- MCP server exposing Unity tools to AI agents.
 * Registers tool providers and routes tool calls.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ICommandSender, IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ConnectionState } from '../core/types';
import { focusUnityEditor } from '../core/unityEditorFocus';
import { getLinkedProjectPath } from '../project/projectHandler';
import { EditorValidationMonitor } from './editorValidationMonitor';
import type { EditorBridgeObservation } from './editorValidationMonitor';
import { ToolRouter } from './toolRouter';
import { UnityMcpTools } from './unityMcpTools';

export class McpModule implements IModule {

	public readonly id = 'mcp';

	private toolRouter: ToolRouter | undefined;
	private disposables: vscode.Disposable[] = [];
	private validationMonitor: EditorValidationMonitor | undefined;
	private projectRoot: string | undefined;
	private observation: EditorBridgeObservation = { transportConnected: false, lastMainThreadResponse: 0 };
	private active = false;

	public async activate(ctx: ModuleContext): Promise<void> {
		this.active = true;
		this.toolRouter = new ToolRouter();

		const sender: ICommandSender = {
			send: (command, payload) => {
				if (this.observation.projectInfo != null) { ctx.commandSender.send(command, payload); }
			},
			request: async (command, payload) => {
				if (!this.active) { return { result: { success: false, error: 'module_inactive: Editor tools are unavailable after extension deactivation.' } }; }
				this.refreshMonitor(ctx, sender);
				const observation = this.observation;
				if (this.projectRoot == null) { return { result: { success: false, error: 'project_not_selected: Link a Unity project before calling Editor tools.' } }; }
				if (observation.projectInfo == null) {
					const response = await ctx.commandSender.request('mcpToolCall', { toolName: 'project_info', args: {} });
					this.refreshMonitor(ctx, sender);
					if (this.observation !== observation || !this.acceptProjectInfo(response?.result)) {
						const args = payload?.args;
						const operationId = args != null && typeof args === 'object' ? (args as Record<string, unknown>).operationId : undefined;
						return { result: { success: false, error: 'project_unverified: The bridge did not confirm the linked Unity project.',
							projectPath: this.projectRoot, operationId, status: 'blocked', pending: false, observedUtc: new Date().toISOString() } };
					}
					if (command === 'mcpToolCall' && payload?.toolName === 'project_info') { return response; }
				}
				const response = await ctx.commandSender.request(command, payload);
				if (response != null && this.observation === observation) { observation.lastMainThreadResponse = Date.now(); }
				return response;
			}
		};
		this.disposables.push(ctx.connectionManager.onStateChanged(info => {
			this.refreshMonitor(ctx, sender);
			this.observation = { transportConnected: info.state === ConnectionState.Connected, port: info.port, lastMainThreadResponse: 0 };
		}));
		this.disposables.push(ctx.connectionManager.onMessage(message => {
			if (message.command !== 'mcpToolResult' || typeof message.payload._requestId !== 'string') { return; }
			if (message.payload.tool === 'project_info') { this.acceptProjectInfo(message.payload.result); }
			if (this.observation.projectInfo != null) { this.observation.lastMainThreadResponse = Date.now(); }
		}));
		this.refreshMonitor(ctx, sender);
		const unityTools = new UnityMcpTools(sender, () => this.refreshMonitor(ctx, sender));
		this.toolRouter.register(unityTools);

		ctx.registerToolProvider(unityTools);

		ctx.registerStatusBarContributor(new McpStatusContributor());
	}

	public getToolRouter(): ToolRouter | undefined {
		return this.toolRouter;
	}

	public async deactivate(): Promise<void> {
		this.active = false;
		this.validationMonitor?.dispose();
		this.validationMonitor = undefined;
		this.projectRoot = undefined;
		this.observation = { transportConnected: false, lastMainThreadResponse: 0 };
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}

	private refreshMonitor(ctx: ModuleContext, sender: ICommandSender): EditorValidationMonitor | undefined {
		if (!this.active) { return undefined; }
		const linked = getLinkedProjectPath();
		const projectRoot = linked == null ? undefined : path.resolve(linked);
		if (projectRoot === this.projectRoot) { return this.validationMonitor; }
		this.validationMonitor?.dispose();
		this.projectRoot = projectRoot;
		this.observation = { transportConnected: ctx.connectionManager.info.state === ConnectionState.Connected,
			port: ctx.connectionManager.info.port, lastMainThreadResponse: 0 };
		this.validationMonitor = projectRoot == null ? undefined : new EditorValidationMonitor(sender, () => this.observation, projectRoot, undefined, undefined,
			process.env.UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY === '1' ? undefined : focusUnityEditor);
		this.validationMonitor?.start();
		return this.validationMonitor;
	}

	private acceptProjectInfo(value: unknown): boolean {
		let info: Record<string, unknown> | undefined;
		try { info = typeof value === 'string' ? JSON.parse(value) : value as Record<string, unknown> | undefined; }
		catch { return false; }
		if (info == null || typeof info.projectPath !== 'string' || this.projectRoot == null
			|| path.resolve(info.projectPath) !== this.projectRoot || !this.observation.transportConnected) { return false; }
		this.observation.projectInfo = info;
		this.observation.lastMainThreadResponse = Date.now();
		return true;
	}
}

class McpStatusContributor implements IStatusBarContributor {

	public readonly group = 'Play Mode';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(play) Play', command: 'unity-cursor-toolkit.playMode.enter' },
			{ label: '$(debug-pause) Pause', command: 'unity-cursor-toolkit.playMode.pause' },
			{ label: '$(debug-stop) Stop', command: 'unity-cursor-toolkit.playMode.exit' },
			{ label: '$(debug-step-over) Step', command: 'unity-cursor-toolkit.playMode.step' },
			{ label: '$(device-camera) Capture Screenshot', command: 'unity-cursor-toolkit.screenshot' }
		];
	}
}
