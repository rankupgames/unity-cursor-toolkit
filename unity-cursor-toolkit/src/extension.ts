/**
 * Unity Cursor Toolkit extension
 * A VS Code extension for improving Unity C# development workflow
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Import modules
import {
    handleUnityProjectSetup,
    hasLinkedUnityProject,
    getLinkedProjectPath,
    initializeUnityProjectHandler,
    clearLinkedProjectOnExit,
    isScriptInstalledInLinkedProject
} from './modules/unityProjectHandler';
import { connectToUnity, closeConnection, triggerUnityRefresh, setSocketNeededCallback } from './modules/socketConnection';
import { enableFileWatchers, disableFileWatchers } from './modules/fileWatcher';
import { initializeConsoleBridge } from './modules/consoleBridge';
import { PlasticTimelineViewProvider } from './panels/plasticTimelineViewProvider';

// Status bar items
let projectStatusBarItem: vscode.StatusBarItem;

// Global state for hot reload status
let hotReloadActive = false;
let connectedPort: number | null = null; // Store the connected port

// Grace period handling for transient disconnects
const DISCONNECT_GRACE_MS = 15000; // 15s grace
let lastKnownGoodPort: number | null = null;
let disconnectGraceUntil: number | null = null;

// Helper function to encapsulate the connection logic
async function attemptConnectionSequence(isInitialProjectSetup: boolean) {
    let projectPath = getLinkedProjectPath();

    // If we already have a project and the script is installed, skip the setup step
    const canSkipSetup = hasLinkedUnityProject() && isScriptInstalledInLinkedProject();

    if (!canSkipSetup && (isInitialProjectSetup || !projectPath)) {
        const setupSuccess = await handleUnityProjectSetup();
        if (!setupSuccess) {
            vscode.window.showErrorMessage('Failed to attach Unity project. Please try again.');
            hotReloadActive = false;
            connectedPort = null;
            updateStatusBarItems();
            return;
        }
        projectPath = getLinkedProjectPath(); // Re-fetch after setup
    }

    if (projectPath) {
        vscode.window.showInformationMessage(`Attempting to connect to Unity project: ${path.basename(projectPath)}...`);
        hotReloadActive = true; // Set to true to indicate an attempt is in progress, port is null until connection
        connectedPort = null;   // Reset port during connection attempt
        updateStatusBarItems(); // Show spinning icon

        try {
            const port = await connectToUnity(true); // isInitialAttempt = true
            if (port) {
                vscode.window.showInformationMessage(`Successfully connected to Unity project: ${path.basename(projectPath)} on port ${port}`);
                connectedPort = port;
                lastKnownGoodPort = port;
                disconnectGraceUntil = null; // Clear any previous grace window
                // hotReloadActive is already true
                enableFileWatchers();
            } else {
                // connectToUnity(true) shows an error message if all ports fail
                hotReloadActive = false;
                connectedPort = null;
                disableFileWatchers();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error connecting to Unity: ${error}`);
            hotReloadActive = false;
            connectedPort = null;
            disableFileWatchers();
        }
    } else {
        vscode.window.showErrorMessage('No Unity project path found. Please attach a project first.');
        hotReloadActive = false;
        connectedPort = null;
    }
    updateStatusBarItems();
}

function stopConnectionSequence(showMessages: boolean = true) {
    if (showMessages) {
        vscode.window.showInformationMessage('Stopping Unity connection...');
    }
    closeConnection();
    disableFileWatchers();
    hotReloadActive = false;
    connectedPort = null;
    lastKnownGoodPort = null;
    disconnectGraceUntil = null;
    updateStatusBarItems();
    if (showMessages) {
        vscode.window.showInformationMessage('Unity connection stopped.');
    }
}

/**
 * Activate the extension - main entry point
 * @param context Extension context
 */
export function activate(context: vscode.ExtensionContext) {
    initializeUnityProjectHandler(context);
    setSocketNeededCallback(() => hotReloadActive);
    initializeConsoleBridge();

    // Register view provider first so commands can target it
    const plasticProvider = new PlasticTimelineViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PlasticTimelineViewProvider.viewId,
            plasticProvider
        )
    );
    registerCommands(context, plasticProvider);
    createStatusBarItems(context); // Create status bar after commands are registered
    autoDetectUnityProjects();

    vscode.window.showInformationMessage('Unity Cursor Toolkit extension is now active');
}

/**
 * Register all extension commands
 * @param context Extension context
 */
function registerCommands(context: vscode.ExtensionContext, plasticProvider: PlasticTimelineViewProvider) {
    const startConnectionCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.startConnection',
        async () => {
            await attemptConnectionSequence(true); // true for initial project setup if needed
        }
    );

    const reloadConnectionCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.reloadConnection',
        async () => {
            if (!getLinkedProjectPath()) {
                vscode.window.showWarningMessage('No Unity project is currently attached. Please use "Start/Attach to Project" first.');
                return;
            }
            vscode.window.showInformationMessage('Reloading Unity connection...');
            stopConnectionSequence(false); // Silently stop before reload
            await attemptConnectionSequence(false); // false for not forcing project re-selection
        }
    );

    const stopConnectionCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.stopConnection',
        () => {
            stopConnectionSequence(true);
        }
    );

    const refreshTimelineCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.plasticTimeline.refresh',
        () => {
            // Forward a refresh message to the sidebar view
            try {
                (plasticProvider as any).refresh?.();
            } catch (e) {
                vscode.window.showInformationMessage('Plastic Timeline view is not visible. Open the Unity Cursor view in the Activity Bar and try again.');
            }
        }
    );

    const showPlasticLogsCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.plasticTimeline.showLogs',
        () => {
            // Re-create gets the same named channel instance and brings it to front
            const ch = vscode.window.createOutputChannel('Unity Cursor: Plastic Timeline');
            ch.show(true);
            ch.appendLine('(Logs) Opened Plastic Timeline logs');
        }
    );

    const reportConnectionStatusCommand = vscode.commands.registerCommand('unity-cursor-toolkit.reportConnectionStatus', (port: number | null, isActive: boolean) => {
        if (isActive && port) {
            // Healthy connection report
            connectedPort = port;
            lastKnownGoodPort = port;
            hotReloadActive = true;
            disconnectGraceUntil = null;
        } else {
            // Disconnection report: start/extend grace window and keep UI as connected
            const now = Date.now();
            disconnectGraceUntil = now + DISCONNECT_GRACE_MS;
            // Keep showing last known connection state during grace
            if (lastKnownGoodPort) {
                connectedPort = lastKnownGoodPort;
                hotReloadActive = true;
            } else {
                connectedPort = null;
                hotReloadActive = false;
            }

            // After grace expires, if still down, mark as disconnected
            setTimeout(() => {
                if (disconnectGraceUntil && Date.now() >= disconnectGraceUntil) {
                    if (!isActive) {
                        connectedPort = null;
                        hotReloadActive = false;
                        updateStatusBarItems();
                    }
                    disconnectGraceUntil = null;
                }
            }, DISCONNECT_GRACE_MS + 100);
        }
        updateStatusBarItems();
    });

    context.subscriptions.push(
        startConnectionCommand,
        reloadConnectionCommand,
        stopConnectionCommand,
        reportConnectionStatusCommand,
        refreshTimelineCommand,
        showPlasticLogsCommand
    );
}

/**
 * Create status bar UI elements
 * @param context Extension context
 */
function createStatusBarItems(context: vscode.ExtensionContext) {
    projectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    projectStatusBarItem.command = 'unity-cursor-toolkit.startConnection';
    context.subscriptions.push(projectStatusBarItem);
    updateStatusBarItems(); // Initial update of text and tooltip
}

/**
 * Auto-detect Unity projects in workspace
 */
function autoDetectUnityProjects() {
    if (hasLinkedUnityProject()) {
        console.log('Found linked Unity project from previous session.');
        // Do not auto-connect, let user click status bar or use command
        updateStatusBarItems();
        return;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        updateStatusBarItems();
        return;
    }
    for (const folder of workspaceFolders) {
        const assetsPath = path.join(folder.uri.fsPath, 'Assets');
        if (fs.existsSync(assetsPath)) {
            console.log(`Auto-detected Unity project in workspace: ${folder.name}. Suggesting to link.`);
            // We don't auto-link here anymore, just update status bar to show "Attach"
            // User needs to click to start the process.
            updateStatusBarItems();
            return; // Found one, that's enough to update the initial status bar prompt
        }
    }
    updateStatusBarItems(); // If no Unity project detected
}

/**
 * Update status bar appearance based on current state
 */
function updateStatusBarItems() {
    if (!projectStatusBarItem) return; // Guard if called before item is created

    const projectPath = getLinkedProjectPath();
    const projectName = projectPath ? path.basename(projectPath) : '';

    // If we are inside a grace window, keep the "connected" appearance
    const inGrace = !!disconnectGraceUntil && Date.now() < (disconnectGraceUntil as number);

    if (projectPath && (hotReloadActive || inGrace) && connectedPort) {
        projectStatusBarItem.text = `$(circle-filled) Unity (${projectName})`;
        projectStatusBarItem.tooltip = `Project: ${projectName} (Port: ${connectedPort}). Hot Reload Active${inGrace ? ' (grace)' : ''}. Click to Reload Connection.`;
        projectStatusBarItem.color = new vscode.ThemeColor('charts.green');
        projectStatusBarItem.backgroundColor = undefined;
        projectStatusBarItem.command = 'unity-cursor-toolkit.reloadConnection';
    } else if (projectPath && (hotReloadActive || inGrace) && !connectedPort) { // Connecting state
        projectStatusBarItem.text = `$(sync~spin) Unity (${projectName})`;
        projectStatusBarItem.tooltip = `Connecting to: ${projectName}. Hot Reload Pending. Click to Stop Connection.`;
        projectStatusBarItem.color = undefined;
        projectStatusBarItem.backgroundColor = undefined;
        projectStatusBarItem.command = 'unity-cursor-toolkit.stopConnection';
    } else if (projectPath) { // Disconnected state
        projectStatusBarItem.text = `$(debug-disconnect) Unity (${projectName})`;
        projectStatusBarItem.tooltip = `Project: ${projectName}. Disconnected. Click to Start/Attach Project.`;
        projectStatusBarItem.color = undefined;
        projectStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        projectStatusBarItem.command = 'unity-cursor-toolkit.startConnection';
    } else { // No project linked
        projectStatusBarItem.text = "$(plug) Unity Attach";
        projectStatusBarItem.tooltip = "No Unity project attached. Click to Start/Attach Project.";
        projectStatusBarItem.color = undefined;
        projectStatusBarItem.backgroundColor = undefined;
        projectStatusBarItem.command = 'unity-cursor-toolkit.startConnection';
    }
    projectStatusBarItem.show();
}

/**
 * Clean up resources when extension is deactivated
 */
export function deactivate() {
    clearLinkedProjectOnExit();
    if (hotReloadActive || connectedPort) {
        closeConnection();
        disableFileWatchers();
    }
    hotReloadActive = false;
    connectedPort = null;
    lastKnownGoodPort = null;
    disconnectGraceUntil = null;
    if (projectStatusBarItem) {
        projectStatusBarItem.dispose();
    }
}