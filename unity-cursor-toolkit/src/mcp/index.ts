/**
 * MCP Module -- MCP server exposing Unity tools to AI agents.
 * Registers tool providers and routes tool calls.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IModule, ModuleContext, IToolProvider, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ToolRouter } from './toolRouter';
import { UnityMcpTools } from './unityMcpTools';

export class McpModule implements IModule {

	public readonly id = 'mcp';

	private toolRouter: ToolRouter | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		this.toolRouter = new ToolRouter();

		const unityTools = new UnityMcpTools(ctx.commandSender);
		this.toolRouter.register(unityTools);

		ctx.registerToolProvider(unityTools);

		ctx.registerStatusBarContributor(new McpStatusContributor());
	}

	public getToolRouter(): ToolRouter | undefined {
		return this.toolRouter;
	}

	public async deactivate(): Promise<void> {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
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
