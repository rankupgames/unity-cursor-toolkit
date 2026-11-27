/**
 * Debug Module -- MonoDebugger integration, launch.json, attach command.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { ICommandSender, IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { UnityDebugAdapterDescriptorFactory } from './debugAdapter';
import { generateLaunchJson, UNITY_EDITOR_ATTACH_NAME } from './launchJsonGenerator';
import { getLinkedProjectPath } from '../project/index';
import { getDebuggerType } from '../core/runtimeCapabilities';

const DEBUG_TYPE = 'unityCursorToolkit.debug';
const SET_OPTIMIZATION = 'unity-cursor-toolkit.debug.setCodeOptimization';
const SET_OPTIMIZATION_TITLE = 'Unity Toolkit: Set Code Optimization Mode';
type OptimizationMode = 'Debug' | 'Release';

async function requestOptimization(sender: ICommandSender, target?: OptimizationMode): Promise<OptimizationMode | 'None'> {
	const args = target == null ? { action: 'getCodeOptimization' } : { action: 'setCodeOptimization', mode: target };
	const response = await sender.request('mcpToolCall', { toolName: 'editor_lifecycle', args });
	const result = response?.result as Record<string, unknown> | undefined;
	const mode = result?.mode;
	if (result?.success !== true || typeof result.editorVersion !== 'string' || (mode !== 'Debug' && mode !== 'Release' && mode !== 'None')) {
		throw new Error(typeof result?.error === 'string' ? result.error : 'Unity did not report Code Optimization. Check the Editor connection and package version.');
	}
	if (target != null && target !== mode) throw new Error('Unity did not confirm the requested Code Optimization mode.');
	return mode;
}

export class DebugModule implements IModule {

	public readonly id = 'debug';

	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		const status = new DebugStatusContributor();
		let connectionGeneration = 0;
		const requireLinkedEditor = () => {
			const projectPath = getLinkedProjectPath();
			if (!projectPath || ctx.connectionManager.getVerifiedProjectPath() !== projectPath) {
				throw new Error('Use Start/Attach to connect to the linked Unity Editor before changing Code Optimization.');
			}
			return projectPath;
		};
		const readOptimization = async () => {
			const projectPath = requireLinkedEditor();
			const generation = connectionGeneration;
			const mode = await requestOptimization(ctx.commandSender);
			if (generation !== connectionGeneration || projectPath !== requireLinkedEditor()) throw new Error('The Unity connection changed. Try again.');
			status.mode = mode;
			return mode;
		};
		const factory = new UnityDebugAdapterDescriptorFactory(() => ctx.connectionManager.getRuntimeCapabilities());
		this.disposables.push(
			vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory)
		);

		const configProvider: vscode.DebugConfigurationProvider = {
			async resolveDebugConfiguration(
				_folder: vscode.WorkspaceFolder | undefined,
				config: vscode.DebugConfiguration,
				_token?: vscode.CancellationToken
			): Promise<vscode.DebugConfiguration | undefined> {
				if (config.type === DEBUG_TYPE && config.request === 'attach') {
					try {
						getDebuggerType(ctx.connectionManager.getRuntimeCapabilities());
					} catch (error) {
						vscode.window.showErrorMessage(String(error));
						return undefined;
					}
					if (config.name === UNITY_EDITOR_ATTACH_NAME) {
						const mode = await readOptimization().catch(() => undefined);
						if (mode != null && mode !== 'Debug') {
							void vscode.window.showWarningMessage(`Unity Code Optimization is ${mode}. Use "${SET_OPTIMIZATION_TITLE}" to select Debug before attaching.`);
						}
					}
					config.debugPort = config.debugPort ?? 56000;
				}
				return config;
			}
		};
		this.disposables.push(
			vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider)
		);

		ctx.registerCommand('unity-cursor-toolkit.debug.attach', async () => {
			try {
				getDebuggerType(ctx.connectionManager.getRuntimeCapabilities());
			} catch (error) {
				vscode.window.showErrorMessage(String(error));
				return;
			}
			const projectPath = getLinkedProjectPath();
			if (projectPath == null) {
				vscode.window.showWarningMessage('No Unity project attached. Use "Start/Attach" first.');
				return;
			}
			await generateLaunchJson(projectPath);
			await vscode.debug.startDebugging(
				vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath)),
				UNITY_EDITOR_ATTACH_NAME
			);
		});

		ctx.registerCommand(SET_OPTIMIZATION, async () => {
			const generation = connectionGeneration;
			try {
				const projectPath = requireLinkedEditor();
				const mode = await readOptimization();
				const target = await vscode.window.showQuickPick(['Debug', 'Release'], {
					placeHolder: `Current mode: ${mode}. Changing it recompiles and reloads scripts.`
				});
				if ((target !== 'Debug' && target !== 'Release') || target === mode) return;
				if (generation !== connectionGeneration || projectPath !== requireLinkedEditor()) throw new Error('The Unity connection changed. Try again.');
				const applied = await requestOptimization(ctx.commandSender, target);
				if (generation === connectionGeneration) status.mode = applied;
				void vscode.window.showInformationMessage(`Unity Code Optimization is ${applied}. Wait for Unity to reload scripts before attaching.`);
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		});

		ctx.registerStatusBarContributor(status);

		this.disposables.push(ctx.connectionManager.onRuntimeCapabilitiesChanged(() => {
			connectionGeneration++;
			status.mode = undefined;
			try {
				getDebuggerType(ctx.connectionManager.getRuntimeCapabilities());
			} catch { return; }
			const projectPath = getLinkedProjectPath();
			if (projectPath != null) {
				void readOptimization().catch(() => {});
				void generateLaunchJson(projectPath).catch((error: unknown) => {
					vscode.window.showErrorMessage(`Unity debug configuration failed for ${projectPath}: ${error instanceof Error ? error.message : String(error)}. Check .vscode/launch.json permissions and reconnect.`);
				});
			}
		}));
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
	public mode?: OptimizationMode | 'None';

	public getActions(): QuickAccessAction[] {
		return [
			{
				label: '$(debug-alt) Attach Debugger',
				description: 'Attach to Unity Editor or Player',
				command: 'unity-cursor-toolkit.debug.attach'
			},
			{
				label: '$(settings-gear) Code Optimization',
				description: this.mode == null ? undefined : `Last reported: ${this.mode}`,
				command: SET_OPTIMIZATION
			}
		];
	}
}
