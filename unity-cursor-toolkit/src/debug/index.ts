/**
 * Debug Module -- MonoDebugger integration, launch.json, attach command.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { UnityDebugAdapterDescriptorFactory } from './debugAdapter';
import { generateLaunchJson } from './launchJsonGenerator';
import { getLinkedProjectPath } from '../project/index';

const DEBUG_TYPE = 'unityCursorToolkit.debug';

export class DebugModule implements IModule {

	public readonly id = 'debug';

	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		const factory = new UnityDebugAdapterDescriptorFactory();
		this.disposables.push(
			vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory)
		);

		const configProvider: vscode.DebugConfigurationProvider = {
			resolveDebugConfiguration(
				_folder: vscode.WorkspaceFolder | undefined,
				config: vscode.DebugConfiguration,
				_token?: vscode.CancellationToken
			): vscode.ProviderResult<vscode.DebugConfiguration> {
				if (config.type === DEBUG_TYPE && config.request === 'attach') {
					config.debugPort = config.debugPort ?? 56000;
				}
				return config;
			}
		};
		this.disposables.push(
			vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider)
		);

		ctx.registerCommand('unity-cursor-toolkit.debug.attach', async () => {
			const projectPath = getLinkedProjectPath();
			if (projectPath == null) {
				vscode.window.showWarningMessage('No Unity project attached. Use "Start/Attach" first.');
				return;
			}
			await generateLaunchJson(projectPath);
			await vscode.debug.startDebugging(
				vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath)),
				'Attach to Unity Editor'
			);
		});

		ctx.registerStatusBarContributor(new DebugStatusContributor());

		const projectPath = getLinkedProjectPath();
		if (projectPath != null) {
			await generateLaunchJson(projectPath);
		}
	}

	public async deactivate(): Promise<void> {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

class DebugStatusContributor implements IStatusBarContributor {

	public readonly group = 'Debug';

	public getActions(): QuickAccessAction[] {
		return [
			{
				label: '$(debug-alt) Attach Debugger',
				description: 'Attach to Unity Editor or Player',
				command: 'unity-cursor-toolkit.debug.attach'
			}
		];
	}
}
