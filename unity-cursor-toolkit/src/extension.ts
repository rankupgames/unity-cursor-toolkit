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
    vscode.window.showInformationMessage('Unity Cursor Toolkit extension is now active');

    // Register commands
    registerCommands(context);

    // Create status bar items
	createStatusBarItems(context);

	// Set up socket communication
    setSocketNeededCallback(() => hotReloadEnabled);

    // Auto-detect Unity projects
    autoDetectUnityProjects();
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
            vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Enabled');
            updateStatusBarItems(hotReloadEnabled);
        }
    );

    const disableHotReloadCommand = vscode.commands.registerCommand(
        'unity-cursor-toolkit.disableHotReload',
        () => {
            disableHotReload();
            vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Disabled');
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

            // Auto-enable hot reload when attaching to a project
            enableHotReload();
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
    hotReloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    hotReloadStatusBarItem.command = hotReloadEnabled ? 'unity-cursor-toolkit.disableHotReload' : 'unity-cursor-toolkit.enableHotReload';
    context.subscriptions.push(hotReloadStatusBarItem);

    // Project status button
    projectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    projectStatusBarItem.command = 'unity-cursor-toolkit.attachUnityProject';
    context.subscriptions.push(projectStatusBarItem);

    // Register context menu for additional options
    registerContextMenu(context);

    // Initial update of status bar UI
    updateStatusBarItems(hotReloadEnabled);
}

/**
 * Register context menu for project options
 * @param context Extension context
 */
function registerContextMenu(context: vscode.ExtensionContext) {
    const showContextMenuCommand = vscode.commands.registerCommand('unity-cursor-toolkit.showContextMenu', async () => {
        // Check if we have a linked project and display its status
        const projectPath = getLinkedProjectPath();
        const scriptInstalled = isScriptInstalledInLinkedProject();
        const scriptPath = getScriptPathInLinkedProject();

        // Build menu options
        const actions = buildContextMenuOptions(projectPath, scriptInstalled, scriptPath);

        // Show quick pick menu
        const selected = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Unity Toolkit Options'
        });

        // Handle selection
        handleContextMenuSelection(selected);
    });

    context.subscriptions.push(showContextMenuCommand);

    // Add right-click tooltip to status bar
    projectStatusBarItem.tooltip = "Unity Toolkit Project. Right-click for project options.";
}

/**
 * Build context menu options based on current state
 */
function buildContextMenuOptions(projectPath: string | undefined, scriptInstalled: boolean, scriptPath: string | undefined) {
    const actions: any[] = [];

    // Project status section
    if (projectPath) {
        // Project info
        actions.push({
            label: `$(check) Project linked: ${path.basename(projectPath)}`,
            description: projectPath,
            action: '' // No action for status item
        });

        // Script status
        if (scriptInstalled) {
            actions.push({
                label: `$(check) Hot Reload Script: Installed`,
                description: path.join('Assets', 'Editor', 'HotReloadHandler.cs'),
                action: '' // No action for status item
            });
        } else {
            actions.push({
                label: `$(warning) Hot Reload Script: Not installed`,
                description: 'Script will be installed when attached',
                action: '' // No action for status item
            });
        }

        // Connection status
        actions.push({
            label: hotReloadEnabled ?
                `$(plug) Connection: Active` :
                `$(circle-slash) Connection: Inactive`,
            description: hotReloadEnabled ?
                'Editor connection established' :
                'Click "Hot Reload: Off" to enable',
            action: '' // No action for status item
        });
    } else {
        actions.push({
            label: `$(warning) No Unity project linked`,
            description: 'Attach a project to enable hot reload',
            action: '' // No action for status item
        });
    }

    // Separator
    actions.push({
        label: '$(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash) $(dash)',
        action: '' // No action for separator
    });

    // Action items
    actions.push(
        { label: "$(plug) Attach Unity Project", action: 'attachUnityProject' },
        { label: "$(refresh) Force Reload Unity", action: 'forceReload' }
    );

    // Project management options
    if (projectPath) {
        actions.push({
            label: "$(folder-opened) Open Project Folder",
            action: 'openProjectFolder',
            projectPath: projectPath
        });

        // Script options
        if (scriptPath) {
            actions.push({
                label: "$(file-code) Open Hot Reload Script",
                action: 'openHotReloadScript',
                scriptPath: scriptPath
            });
        }
    }

    return actions;
}

/**
 * Handle selection from context menu
 */
async function handleContextMenuSelection(selected: any) {
    if (!selected || !selected.action) {
        return;
    }

    if (selected.action === 'openProjectFolder' && selected.projectPath) {
        // Open the project folder in the system file explorer
        vscode.env.openExternal(vscode.Uri.file(selected.projectPath));
    } else if (selected.action === 'openHotReloadScript' && selected.scriptPath) {
        // Open the script file in the editor
        const document = await vscode.workspace.openTextDocument(selected.scriptPath);
        await vscode.window.showTextDocument(document);
    } else {
        vscode.commands.executeCommand(`unity-cursor-toolkit.${selected.action}`);
    }
}

/**
 * Auto-detect Unity projects in workspace
 */
function autoDetectUnityProjects() {
    // Check for linked Unity project first
    if (hasLinkedUnityProject()) {
        console.log('Found linked Unity project, auto-enabling hot reload');
        enableHotReload();
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
        if (fs.existsSync(assetsPath)) {
            unityProjectFound = true;
            break;
        }
    }

    if (unityProjectFound) {
        enableHotReload();
        updateStatusBarItems(hotReloadEnabled);
    }
}

/**
 * Update status bar appearance based on current state
 */
function updateStatusBarItems(hotReloadEnabled: boolean) {
    if (hotReloadEnabled) {
        hotReloadStatusBarItem.text = "$(sync) Unity Hot Reload: On";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is enabled. Click to disable.";
        hotReloadStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        hotReloadStatusBarItem.command = 'unity-cursor-toolkit.disableHotReload';
    } else {
        hotReloadStatusBarItem.text = "$(sync-ignored) Unity Hot Reload: Off";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is disabled. Click to enable.";
        hotReloadStatusBarItem.backgroundColor = undefined;
        hotReloadStatusBarItem.command = 'unity-cursor-toolkit.enableHotReload';
    }

    // Show items
    hotReloadStatusBarItem.show();
    projectStatusBarItem.show();
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
        vscode.window.showWarningMessage('No Unity project linked. Please attach a Unity project first.');
        vscode.commands.executeCommand('unity-cursor-toolkit.attachUnityProject');
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