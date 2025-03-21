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
    isScriptInstalledInLinkedProject,
    getScriptPathInLinkedProject
} from './modules/unityProjectHandler';
import { connectToUnity, closeConnection, setSocketNeededCallback } from './modules/socketConnection';
import { enableFileWatchers, disableFileWatchers } from './modules/fileWatcher';

// Status bar items
let hotReloadStatusBarItem: vscode.StatusBarItem;
let projectStatusBarItem: vscode.StatusBarItem;

// Global state
let hotReloadEnabled = false;

/**
 * Activate the extension - main entry point
 * @param context Extension context
 */
export function activate(context: vscode.ExtensionContext) {
    // Register commands
    registerCommands(context);

    // Create status bar items
    createStatusBarItems(context);

    // Set up socket communication
    setSocketNeededCallback(() => hotReloadEnabled);

    // Auto-detect Unity projects
    autoDetectUnityProjects();

    vscode.window.showInformationMessage('Unity Cursor Toolkit extension is now active');
}

/**
 * Register all extension commands
 * @param context Extension context
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Register Hot Reload commands
    const enableHotReloadCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.enableHotReload',
        () => {
			enableHotReload();
			if (hotReloadEnabled) {
				vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Enabled');
			}

			updateStatusBarItems(hotReloadEnabled);
        }
    );

    const disableHotReloadCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.disableHotReload',
        () => {
            disableHotReload();
            if (!hotReloadEnabled) {
                vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Disabled');
            }

            updateStatusBarItems(hotReloadEnabled);
        }
    );

    const forceReloadCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.forceReload',
        () => {
            if (!hotReloadEnabled) {
                vscode.window.showWarningMessage('Unity Toolkit: Hot Reload must be enabled to force reload');
                return;
            }

            // Close and reopen connection to force a full reload
            closeConnection();
            connectToUnity();
            vscode.window.showInformationMessage('Unity Toolkit: Force Reload Triggered');
        }
    );

    // Register Project Setup command
    const attachToProjectCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.attachUnityProject',
        async () => {
            const success = await handleUnityProjectSetup();
            if (!success) {
                vscode.window.showErrorMessage('Failed to attach Unity project');
                return;
            }

            // Get the project path to display in the message
            const projectPath = getLinkedProjectPath();
            if (projectPath) {
                vscode.window.showInformationMessage(`Successfully attached Unity project at: ${projectPath}`);
            }

            // Force update status bar to show the linked project
            updateStatusBarItems(hotReloadEnabled);
        }
    );

    // Add all commands to subscriptions
    context.subscriptions.push(
        enableHotReloadCommand,
        disableHotReloadCommand,
        attachToProjectCommand,
        forceReloadCommand
    );
}

/**
 * Create status bar UI elements
 * @param context Extension context
 */
function createStatusBarItems(context: vscode.ExtensionContext) {
    // Hot Reload status button
	hotReloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    hotReloadStatusBarItem.command = hotReloadEnabled ? 'unity-cursor-toolkit.disableHotReload' : 'unity-cursor-toolkit.enableHotReload';
    context.subscriptions.push(hotReloadStatusBarItem);

    // Project status button
	projectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    projectStatusBarItem.command = 'unity-cursor-toolkit.attachUnityProject';
    projectStatusBarItem.tooltip = "Attach Unity Project";
    context.subscriptions.push(projectStatusBarItem);

    // Initial update of status bar UI
    updateStatusBarItems(hotReloadEnabled);
}

/**
 * Auto-detect Unity projects in workspace
 */
function autoDetectUnityProjects() {
    // Check for linked Unity project first
    if (hasLinkedUnityProject()) {
        console.log('Found linked Unity project');
        updateStatusBarItems(hotReloadEnabled);
        return;
    }

    // If no linked project, check for Unity projects in workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    let unityProjectFound = false;
    for (const folder of workspaceFolders) {
        const assetsPath = path.join(folder.uri.fsPath, 'Assets');
        if (fs.existsSync(assetsPath) === false) {
            continue;
        }

		unityProjectFound = true;
		break;
    }

    if (unityProjectFound) {
        updateStatusBarItems(hotReloadEnabled);
    }
}

/**
 * Update status bar appearance based on current state
 */
function updateStatusBarItems(hotReloadEnabled: boolean) {
    // Update Hot Reload status item
    if (hotReloadEnabled) {
        hotReloadStatusBarItem.text = "$(sync) Unity Hot Reload: On";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is enabled. Click to disable.";
        hotReloadStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.activeBackground');
        hotReloadStatusBarItem.command = 'unity-cursor-toolkit.disableHotReload';
    } else {
        hotReloadStatusBarItem.text = "$(sync-ignored) Unity Hot Reload: Off";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is disabled. Click to enable.";
        hotReloadStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); // Orange/red highlight when off
        hotReloadStatusBarItem.command = 'unity-cursor-toolkit.enableHotReload';
    }

    // Update Project status item
    const projectPath = getLinkedProjectPath();
    if (projectPath) {
        projectStatusBarItem.text = `$(file-directory) Unity Project: ${path.basename(projectPath)}`;
        projectStatusBarItem.tooltip = `Unity Project: ${projectPath}\nClick to change project`;
    } else {
        projectStatusBarItem.text = "$(file-directory-create) Attach Unity Project";
        projectStatusBarItem.tooltip = "No Unity project attached. Click to attach.";
    }

    // Ensure items are visible
    projectStatusBarItem.show();
    hotReloadStatusBarItem.show();
}

/**
 * Enable hot reload functionality
 */
function enableHotReload() {
    if (hotReloadEnabled) {
        return;
    }

    // Check if we have a linked project before enabling
    if (!hasLinkedUnityProject()) {
        vscode.window.showErrorMessage('No Unity project linked. Please attach a Unity project first before enabling Hot Reload.');
        return;
    }

    hotReloadEnabled = true;

    // Enable file watchers
    enableFileWatchers();

    // Connect to Unity
    connectToUnity();

    // Update status bar
    updateStatusBarItems(hotReloadEnabled);
}

/**
 * Disable hot reload functionality
 */
function disableHotReload() {
    if (!hotReloadEnabled) {
        return;
    }

    hotReloadEnabled = false;

    // Disable file watchers
    disableFileWatchers();

    // Close Unity connection
    closeConnection();

    // Update status bar
    updateStatusBarItems(hotReloadEnabled);
}

/**
 * Clean up resources when extension is deactivated
 */
export function deactivate() {
    // Disable hot reload
    disableHotReload();

    // Clean up status bar items
    if (hotReloadStatusBarItem) {
        hotReloadStatusBarItem.dispose();
    }

    if (projectStatusBarItem) {
        projectStatusBarItem.dispose();
    }
}