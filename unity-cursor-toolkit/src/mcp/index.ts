/**
 * MCP Module -- MCP server exposing Unity tools to AI agents.
 * Registers tool providers and routes tool calls.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ToolRouter } from './toolRouter';
import { UnityMcpTools } from './unityMcpTools';
import { UnityTestMcpTools } from './unityTestTools';
import { UnityTestCommands } from './unityTestCommands';
import { isMcpReadOnlyMode } from './toolMetadata';
import { UnityCliTestAdapter } from '../core/unityCliTestAdapter';
import { UnityCliAdapter } from '../core/unityCliAdapter';
import { getLinkedProjectPath } from '../project/projectHandler';

export class McpModule implements IModule {

	public readonly id = 'mcp';

	private toolRouter: ToolRouter | undefined;
	private disposables: vscode.Disposable[] = [];
	private testCommands: UnityTestCommands | undefined;

	public async activate(ctx: ModuleContext): Promise<void> {
		this.toolRouter = new ToolRouter(isMcpReadOnlyMode());

		const unityTools = new UnityMcpTools(ctx.commandSender, getLinkedProjectPath);
		this.toolRouter.register(unityTools, 'toolkit');

		ctx.registerToolProvider(unityTools);
		const cliPath = vscode.workspace.getConfiguration('unityCursorToolkit.unityCli').get<string>('path');
		const tests = new UnityTestMcpTools(ctx.commandSender, getLinkedProjectPath, new UnityCliTestAdapter(new UnityCliAdapter(cliPath)), isMcpReadOnlyMode());
		this.toolRouter.register(tests, 'toolkit');
		ctx.registerToolProvider(tests);
		this.testCommands = new UnityTestCommands(ctx, tests);
		this.disposables.push(this.testCommands);

		ctx.registerStatusBarContributor(new McpStatusContributor());
	}

	public getToolRouter(): ToolRouter | undefined {
		return this.toolRouter;
	}

	public async deactivate(): Promise<void> {
		await this.testCommands?.stop();
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
