/**
 * Unity Cursor Toolkit extension
 * A VS Code extension for improving Unity C# development workflow
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Changes: Refactored project selection to use a single command triggered by the status bar.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Import modules
import {
    selectAndAttachProject,
    hasLinkedUnityProject,
    getLinkedProjectPath,
} from './modules/unityProjectHandler';
import { connectToUnity, closeConnection, setSocketNeededCallback } from './modules/socketConnection';
import { enableFileWatchers, disableFileWatchers } from './modules/fileWatcher';
import { RiderBackendConnector } from './modules/riderIntegration';

// Status bar items
let hotReloadStatusBarItem: vscode.StatusBarItem;
let projectStatusBarItem: vscode.StatusBarItem;

// Global state
let hotReloadEnabled = false;
let riderConnector: RiderBackendConnector;

/**
 * Activate the extension - main entry point
 * @param context Extension context
 */
export function activate(context: vscode.ExtensionContext) {
    // Initialize Rider connector
    riderConnector = new RiderBackendConnector();

    // Register commands
    registerCommands(context);

    // Create status bar items
    createStatusBarItems(context);

    // Set up socket communication
    setSocketNeededCallback(() => hotReloadEnabled);

    // Auto-detect Unity projects and update status bar - no longer prompts setup
    autoDetectAndUpdateStatusBar();

    // Check if Rider integration is enabled in settings
    const config = vscode.workspace.getConfiguration('unity-cursor-toolkit');
    if (config.get('riderIntegration')) {
        riderConnector.connect();
    }

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
    const selectAttachProjectCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.selectAndAttachUnityProject',
        async () => {
            const success = await selectAndAttachProject();
            if (success) {
                const projectPath = getLinkedProjectPath();
                vscode.window.showInformationMessage(`Unity project linked: ${projectPath ? path.basename(projectPath) : 'Unknown'}`);
            } else {
                 vscode.window.showWarningMessage('Unity project selection cancelled or failed.');
            }
            updateStatusBarItems(hotReloadEnabled);
        }
    );

    // Register Rider Integration command
    const toggleRiderCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.toggleRiderIntegration',
        async () => {
            if (riderConnector.isRiderBackendConnected()) {
                riderConnector.disconnect();
            } else {
                await riderConnector.connect();
            }
        }
    );

    // Add all commands to subscriptions
    context.subscriptions.push(
        enableHotReloadCommand,
        disableHotReloadCommand,
        selectAttachProjectCommand,
        forceReloadCommand,
        toggleRiderCommand
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
    projectStatusBarItem.command = 'unity-cursor-toolkit.selectAndAttachUnityProject';
    projectStatusBarItem.tooltip = "Select/Change Linked Unity Project";
    context.subscriptions.push(projectStatusBarItem);

    // Initial update of status bar UI
    updateStatusBarItems(hotReloadEnabled);
}

/**
 * Check for linked project and update status bar - No longer triggers setup
 */
function autoDetectAndUpdateStatusBar() {
    // Just update the status bar based on whether a project is linked or not
    // The user explicitly clicks the button to initiate selection now.
    updateStatusBarItems(hotReloadEnabled);
    // We could potentially add a check here for workspace projects and show a one-time notification
    // suggesting the user click the button if no project is linked, but let's keep it simple for now.
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
        projectStatusBarItem.text = `$(folder-active) Unity: ${path.basename(projectPath)}`;
        projectStatusBarItem.tooltip = `Linked Unity Project: ${projectPath}\nClick to change project`;
    } else {
        projectStatusBarItem.text = "$(folder) Select Unity Project";
        projectStatusBarItem.tooltip = "No Unity project linked. Click to select one.";
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
        vscode.window.showErrorMessage('No Unity project linked. Please select a Unity project using the status bar button first.');
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

    // Clean up Rider connector
    if (riderConnector) {
        riderConnector.dispose();
    }

    // Clean up status bar items
    if (hotReloadStatusBarItem) {
        hotReloadStatusBarItem.dispose();
    }

    if (projectStatusBarItem) {
        projectStatusBarItem.dispose();
    }
}