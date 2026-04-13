/**
 * Unity Cursor Toolkit -- Extension entry point (thin composition root).
 * Wires core services + loads all feature modules via ModuleLoader.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { ConnectionManager } from './core/connection';
import { CommandSender } from './core/commandSender';
import { ModuleLoader } from './core/moduleLoader';
import { StatusBarController } from './core/statusBarController';
import { ConnectionState } from './core/types';
import {
	IModule,
	ModuleContext,
	IMessageHandler,
	IToolProvider,
	IStatusBarContributor
} from './core/interfaces';

import { ConsoleModule } from './console/index';
import { HotReloadModule } from './hot-reload/index';
import { McpModule } from './mcp/index';
import { DebugModule } from './debug/index';
import { ProjectModule, hasLinkedUnityProject, getLinkedProjectPath, isScriptInstalledInLinkedProject, handleUnityProjectSetup } from './project/index';

let connection: ConnectionManager;
let commandSender: CommandSender;
let moduleLoader: ModuleLoader;
let statusBar: StatusBarController;

export function activate(context: vscode.ExtensionContext): void {
	connection = new ConnectionManager();
	connection.setNeededCallback(() => connection.info.state !== ConnectionState.Disconnected);

	commandSender = new CommandSender(connection);
	statusBar = new StatusBarController(context);
	moduleLoader = new ModuleLoader();

	const messageHandlers: IMessageHandler[] = [];
	const toolProviders: IToolProvider[] = [];

	const moduleContext: ModuleContext = {
		commandSender,
		extensionContext: context,
		connectionManager: connection,
		registerMessageHandler(handler: IMessageHandler): void {
			messageHandlers.push(handler);
		},
		registerToolProvider(provider: IToolProvider): void {
			toolProviders.push(provider);
		},
		registerStatusBarContributor(contributor: IStatusBarContributor): void {
			statusBar.addContributor(contributor);
		},
		registerCommand(id: string, callback: (...args: unknown[]) => unknown): void {
			context.subscriptions.push(vscode.commands.registerCommand(id, callback));
		}
	};

	moduleLoader.register(new ProjectModule());
	moduleLoader.register(new ConsoleModule());
	moduleLoader.register(new HotReloadModule());
	moduleLoader.register(new McpModule());
	moduleLoader.register(new DebugModule());

	context.subscriptions.push(connection, moduleLoader);

	registerCoreCommands(context);
	registerPlayModeCommands(context);
	listenToConnectionState();
	listenToCompilationResults();
	listenToMessageHandlers(messageHandlers);

	moduleLoader.activateAll(moduleContext).then(() => {
		autoDetectUnityProjects();
		vscode.window.showInformationMessage('Unity Cursor Toolkit is now active');
	});
}

export async function deactivate(): Promise<void> {
	await moduleLoader?.deactivateAll();
	commandSender?.dispose();
	connection?.disconnect();
}

function registerPlayModeCommands(context: vscode.ExtensionContext): void {
	const playModeActions = ['enter', 'exit', 'pause', 'step'] as const;
	for (const action of playModeActions) {
		context.subscriptions.push(
			vscode.commands.registerCommand(`unity-cursor-toolkit.playMode.${action}`, () => {
				commandSender.send('mcpToolCall', { toolName: 'play_mode', args: { action } });
			})
		);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('unity-cursor-toolkit.screenshot', async () => {
			const result = await commandSender.request('mcpToolCall', { toolName: 'screenshot', args: {} });
			if (result?.result) {
				vscode.window.showInformationMessage(`Screenshot saved: ${result.result}`);
			}
		})
	);
}

function registerCoreCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('unity-cursor-toolkit.startConnection', async () => {
			await attemptConnection(true);
		}),

		vscode.commands.registerCommand('unity-cursor-toolkit.reloadConnection', async () => {
			if (getLinkedProjectPath() == null) {
				vscode.window.showWarningMessage('No Unity project attached. Use "Start/Attach" first.');
				return;
			}
			connection.disconnect();
			await attemptConnection(false);
		}),

		vscode.commands.registerCommand('unity-cursor-toolkit.stopConnection', () => {
			connection.disconnect();
			vscode.window.showInformationMessage('Unity connection stopped.');
		})
	);
}

async function attemptConnection(isInitialSetup: boolean): Promise<void> {
	let projectPath = getLinkedProjectPath();
	const canSkip = hasLinkedUnityProject() && isScriptInstalledInLinkedProject();

	if (canSkip === false && (isInitialSetup || projectPath == null)) {
		const success = await handleUnityProjectSetup();
		if (success === false) {
			vscode.window.showErrorMessage('Failed to attach Unity project.');
			return;
		}
		projectPath = getLinkedProjectPath();
	}

	if (projectPath == null) {
		vscode.window.showErrorMessage('No Unity project path found.');
		return;
	}

	statusBar.setProjectName(path.basename(projectPath));
	vscode.window.showInformationMessage(`Connecting to Unity project: ${path.basename(projectPath)}...`);

	const port = await connection.connect();
	if (port) {
		vscode.window.showInformationMessage(`Connected to Unity on port ${port}`);
	} else {
		vscode.window.showErrorMessage('Failed to connect to Unity. Is it running with the Hot Reload script?');
	}
}

function listenToConnectionState(): void {
	connection.onStateChanged((info) => {
		statusBar.update(info.state, info.port);
	});
}

function listenToCompilationResults(): void {
	connection.onMessage((msg) => {
		if (msg.command === 'compilationStarted') {
			connection.pauseHeartbeat();
			return;
		}

		if (msg.command !== 'compilationResult') {
			return;
		}

		connection.resumeHeartbeat();

		const success = msg.payload.success as boolean;
		const errors = (msg.payload.errors as number) ?? 0;
		const warnings = (msg.payload.warnings as number) ?? 0;

		statusBar.showCompilationResult(success, errors, warnings);

		setTimeout(() => {
			statusBar.update(connection.info.state, connection.info.port);
		}, 5_000);
	});
}

function listenToMessageHandlers(handlers: IMessageHandler[]): void {
	connection.onMessage((msg) => {
		for (const handler of handlers) {
			if (msg.command === handler.commandFilter) {
				handler.handle(msg.payload);
			}
		}
	});
}

function autoDetectUnityProjects(): void {
	if (hasLinkedUnityProject()) {
		const projectPath = getLinkedProjectPath();
		if (projectPath) {
			statusBar.setProjectName(path.basename(projectPath));
		}
		statusBar.update(ConnectionState.Disconnected, null);
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders == null) {
		return;
	}

	for (const folder of workspaceFolders) {
		if (fs.existsSync(path.join(folder.uri.fsPath, 'Assets'))) {
			statusBar.update(ConnectionState.Disconnected, null);
			return;
		}
	}
}
