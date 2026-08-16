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
import { hideUnityEditor, launchOrReuseUnityEditor, matchesUnityProjectInfo, readUnityEditorLaunchFailure, readUnityProjectVersion, UnityEditorLaunchError, UnityEditorLaunchResult } from './core/unityEditorLauncher';
import {
	ModuleContext,
	IMessageHandler,
	IToolProvider,
	IStatusBarContributor
} from './core/interfaces';

import { ConsoleModule } from './console/index';
import { HotReloadModule } from './hot-reload/index';
import { McpModule } from './mcp/index';
import { createCombinedMcpConfigText, getMcpServerPath } from './mcp/clientConfig';
import { DebugModule } from './debug/index';
import { ProjectModule, hasLinkedUnityProject, getLinkedProjectPath, isScriptInstalledInLinkedProject, handleUnityProjectSetup } from './project/index';
import { RemoteShellModule } from './remote-shell/index';
import { ViewportPrototypeModule } from './viewport/index';

let connection: ConnectionManager;
let commandSender: CommandSender;
let moduleLoader: ModuleLoader;
let statusBar: StatusBarController;
let pendingEditorLaunch: Promise<UnityEditorLaunchResult> | undefined;
let pendingConnectionAttempt: Promise<void> | undefined;
let pendingConnectionGeneration: number | undefined;
let pendingProjectConnectionAttempt: {
	readonly generation: number;
	readonly projectPath: string;
	readonly promise: Promise<number | null>;
} | undefined;
let connectionRequested = false;
let connectionRequestGeneration = 0;

const EDITOR_BRIDGE_BOOT_TIMEOUT_MS = 90_000;
const EDITOR_BRIDGE_RETRY_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
	connection = new ConnectionManager();
	connection.setNeededCallback(() => connectionRequested);

	commandSender = new CommandSender(connection);
	connection.setReconnectCallback(async () => {
		if (connectionRequested === false) {
			return undefined;
		}
		const generation = connectionRequestGeneration;
		const projectPath = getLinkedProjectPath();
		if (projectPath == null) {
			abandonConnectionRequest(generation);
			return undefined;
		}
		const port = await connectToLinkedUnityProject(projectPath, generation);
		return isConnectionRequestCurrent(generation) ? port : undefined;
	});
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
	moduleLoader.register(new RemoteShellModule());
	moduleLoader.register(new ViewportPrototypeModule());

	context.subscriptions.push(connection, moduleLoader);

	registerCoreCommands(context);
	registerMcpConfigCommands(context);
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
	cancelConnectionRequests();
	await moduleLoader?.deactivateAll();
	commandSender?.dispose();
	connection?.disconnect();
}

function registerMcpConfigCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('unity-cursor-toolkit.mcp.showServerPath', () => {
			const serverPath = getMcpServerPath(context.extensionPath);
			vscode.window.showInformationMessage(`Unity MCP server: ${serverPath}`);
		}),

		vscode.commands.registerCommand('unity-cursor-toolkit.mcp.copyClientConfig', async () => {
			const serverPath = getMcpServerPath(context.extensionPath);
			const config = createCombinedMcpConfigText({
				serverPath,
				projectPath: getLinkedProjectPath(),
				readOnly: false
			});

			await vscode.env.clipboard.writeText(config);
			vscode.window.showInformationMessage('Unity MCP client config copied to clipboard.');
		})
	);
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
			const screenshotPath = getScreenshotPath(result?.result);
			if (screenshotPath) {
				vscode.window.showInformationMessage(`Screenshot saved: ${screenshotPath}`);
			}
		})
	);
}

function getScreenshotPath(result: unknown): string | undefined {
	if (typeof result === 'string') {
		return result;
	}

	if (typeof result === 'object' && result != null) {
		const pathValue = (result as { path?: unknown }).path;
		return typeof pathValue === 'string' ? pathValue : undefined;
	}

	return undefined;
}

function registerCoreCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('unity-cursor-toolkit.startConnection', async () => {
			await runConnectionAttempt(true);
		}),

		vscode.commands.registerCommand('unity-cursor-toolkit.reloadConnection', async () => {
			if (getLinkedProjectPath() == null) {
				vscode.window.showWarningMessage('No Unity project attached. Use "Start/Attach" first.');
				return;
			}
			connection.disconnect();
			await runConnectionAttempt(false);
		}),

		vscode.commands.registerCommand('unity-cursor-toolkit.stopConnection', () => {
			cancelConnectionRequests();
			connection.disconnect();
			vscode.window.showInformationMessage('Unity connection stopped.');
		})
	);
}

async function runConnectionAttempt(isInitialSetup: boolean): Promise<void> {
	const generation = beginConnectionRequest();
	if (pendingConnectionAttempt != null) {
		const activeAttempt = pendingConnectionAttempt;
		const activeGeneration = pendingConnectionGeneration;
		await activeAttempt;
		if (isConnectionRequestCurrent(generation) === false || activeGeneration === generation) {
			return;
		}
	}

	const attempt = attemptConnection(isInitialSetup, generation);
	pendingConnectionAttempt = attempt;
	pendingConnectionGeneration = generation;
	try {
		await attempt;
	} finally {
		if (pendingConnectionAttempt === attempt) {
			pendingConnectionAttempt = undefined;
			pendingConnectionGeneration = undefined;
		}
	}
}

async function attemptConnection(isInitialSetup: boolean, generation: number): Promise<void> {
	let projectPath = getLinkedProjectPath();
	const canSkip = hasLinkedUnityProject() && isScriptInstalledInLinkedProject();

	if (canSkip === false && (isInitialSetup || projectPath == null)) {
		const success = await handleUnityProjectSetup();
		if (isConnectionRequestCurrent(generation) === false) {
			return;
		}
		if (success === false) {
			vscode.window.showErrorMessage('Failed to attach Unity project.');
			abandonConnectionRequest(generation);
			return;
		}
		projectPath = getLinkedProjectPath();
	}

	if (projectPath == null) {
		vscode.window.showErrorMessage('No Unity project path found.');
		abandonConnectionRequest(generation);
		return;
	}

	statusBar.setProjectName(path.basename(projectPath));
	vscode.window.showInformationMessage(`Connecting to Unity project: ${path.basename(projectPath)}...`);

	const port = await connectToLinkedUnityProject(projectPath, generation);
	if (isConnectionRequestCurrent(generation) === false) {
		return;
	}
	if (port) {
		vscode.window.showInformationMessage(`Connected to Unity on port ${port}`);
		return;
	}

	const autoLaunch = vscode.workspace.getConfiguration('unityCursorToolkit').get<boolean>('autoLaunchEditor', true);
	if (autoLaunch === false) {
		vscode.window.showErrorMessage('Failed to connect to Unity. Auto-launch is disabled; start the linked Unity project, then attach again.');
		abandonConnectionRequest(generation);
		return;
	}

	let launchResult: UnityEditorLaunchResult;
	try {
		launchResult = await launchLinkedUnityEditor(projectPath, generation);
	} catch (error: unknown) {
		if (isConnectionRequestCurrent(generation) === false) {
			return;
		}
		vscode.window.showErrorMessage(`Failed to prepare Unity Editor: ${formatUnityEditorLaunchError(error)}`);
		abandonConnectionRequest(generation);
		return;
	}
	if (isConnectionRequestCurrent(generation) === false) {
		return;
	}

	if (launchResult.reused) {
		const reusedPort = connection.info.port;
		if (reusedPort == null) {
			vscode.window.showErrorMessage('Unity Editor reuse completed without a connected toolkit bridge. Refusing to continue.');
			abandonConnectionRequest(generation);
			return;
		}
		vscode.window.showInformationMessage(`Reused responsive Unity Editor for ${path.basename(projectPath)} on port ${reusedPort}`);
		return;
	}
	if (launchResult.ownershipError != null) {
		vscode.window.showWarningMessage(`Unity Editor started, but duplicate-launch protection is degraded: ${formatUnityEditorLaunchError(launchResult.ownershipError)}`);
	}

	vscode.window.showInformationMessage(`Launching hidden Unity Editor for ${path.basename(projectPath)}...`);
	const launchedPort = await waitForUnityBridge(projectPath, EDITOR_BRIDGE_BOOT_TIMEOUT_MS, generation, launchResult);
	if (isConnectionRequestCurrent(generation) === false) {
		return;
	}
	if (launchedPort) {
		const hidden = await hideUnityEditor(launchResult.pid, process.platform, launchResult.launchId);
		if (isConnectionRequestCurrent(generation) === false) {
			return;
		}
		if (hidden === false) {
			vscode.window.showWarningMessage('Connected to Unity, but the toolkit could not hide the Editor window. The Editor remains open and usable.');
		}
		vscode.window.showInformationMessage(`Connected to Unity on port ${launchedPort}`);
	} else {
		const launchFailure = readUnityEditorLaunchFailure(launchResult.logPath) ?? launchResult.processError;
		if (launchFailure != null) {
			vscode.window.showErrorMessage(`Unity Editor launch failed: ${formatUnityEditorLaunchError(launchFailure)} Unity log: ${launchResult.logPath}`);
		} else {
			vscode.window.showErrorMessage(`Unity Editor launched, but the toolkit bridge did not answer within ${EDITOR_BRIDGE_BOOT_TIMEOUT_MS / 1000}s. The Editor remains open and visible. Confirm it has an active Unity license and inspect the Unity log: ${launchResult.logPath}`);
		}
		abandonConnectionRequest(generation);
	}
}

async function launchLinkedUnityEditor(projectPath: string, generation: number): Promise<UnityEditorLaunchResult> {
	if (pendingEditorLaunch != null) {
		return pendingEditorLaunch;
	}

	pendingEditorLaunch = Promise.resolve().then(() => {
		const configuredPath = vscode.workspace.getConfiguration('unityCursorToolkit').get<string>('unityEditorPath', '');
		return launchOrReuseUnityEditor(projectPath, {
			editorPathOverride: configuredPath,
			hideRetryDelaysMs: [],
			isToolkitResponsive: async () => (await waitForUnityBridge(projectPath, EDITOR_BRIDGE_BOOT_TIMEOUT_MS, generation)) != null
		});
	});

	try {
		return await pendingEditorLaunch;
	} finally {
		pendingEditorLaunch = undefined;
	}
}

async function connectToLinkedUnityProject(projectPath: string, generation: number): Promise<number | null> {
	if (pendingProjectConnectionAttempt?.generation === generation && pendingProjectConnectionAttempt.projectPath === projectPath) {
		return pendingProjectConnectionAttempt.promise;
	}

	const promise = connectToLinkedUnityProjectOnce(projectPath, generation);
	pendingProjectConnectionAttempt = { generation, projectPath, promise };
	try {
		return await promise;
	} finally {
		if (pendingProjectConnectionAttempt?.promise === promise) {
			pendingProjectConnectionAttempt = undefined;
		}
	}
}

async function connectToLinkedUnityProjectOnce(projectPath: string, generation: number): Promise<number | null> {
	const excludedPorts = new Set<number>();
	const expectedVersion = readUnityProjectVersion(projectPath);

	while (isConnectionRequestCurrent(generation)) {
		const port = await connection.connectExcludingPorts(excludedPorts);
		if (isConnectionRequestCurrent(generation) === false) {
			return null;
		}
		if (port == null) {
			return null;
		}

		const response = await commandSender.request('mcpToolCall', { toolName: 'project_info', args: {} });
		if (isConnectionRequestCurrent(generation) === false) {
			return null;
		}
		if (matchesUnityProjectInfo(projectPath, expectedVersion, response)) {
			return port;
		}

		excludedPorts.add(port);
		connection.disconnect();
	}
	return null;
}

function formatUnityEditorLaunchError(error: unknown): string {
	if (error instanceof UnityEditorLaunchError) {
		return `${error.code}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

async function waitForUnityBridge(projectPath: string, timeoutMs: number, generation: number, launchResult?: UnityEditorLaunchResult): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (isConnectionRequestCurrent(generation) && Date.now() < deadline) {
		if (launchResult?.processError != null) {
			connection.disconnect();
			return null;
		}
		const port = await connectToLinkedUnityProject(projectPath, generation);
		if (isConnectionRequestCurrent(generation) === false) {
			return null;
		}
		if (port) {
			if (launchResult?.processError != null) {
				connection.disconnect();
				return null;
			}
			return port;
		}
		if (launchResult?.processError != null) {
			return null;
		}
		await sleep(EDITOR_BRIDGE_RETRY_MS);
	}
	return null;
}

function beginConnectionRequest(): number {
	if (connectionRequested === false) {
		connectionRequested = true;
		connectionRequestGeneration++;
	}
	return connectionRequestGeneration;
}

function cancelConnectionRequests(): void {
	connectionRequested = false;
	connectionRequestGeneration++;
}

function abandonConnectionRequest(generation: number): void {
	if (isConnectionRequestCurrent(generation)) {
		cancelConnectionRequests();
	}
}

function isConnectionRequestCurrent(generation: number): boolean {
	return connectionRequested && connectionRequestGeneration === generation;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
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
