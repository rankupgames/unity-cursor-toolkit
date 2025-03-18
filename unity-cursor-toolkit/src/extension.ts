import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

// Default port for communication with Unity Editor
const DEFAULT_UNITY_HOT_RELOAD_PORT = 55500;
// Ports to try in sequence if the default port is unavailable
const ALTERNATIVE_PORTS = [55500, 55501, 55502, 55503, 55504];
let currentPort = DEFAULT_UNITY_HOT_RELOAD_PORT;
let socketClient: net.Socket | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let solutionWatcher: vscode.FileSystemWatcher | undefined;
let hotReloadEnabled = false;

// Status bar items
let hotReloadStatusBarItem: vscode.StatusBarItem;
let selectProjectStatusBarItem: vscode.StatusBarItem;
let installScriptStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Unity Cursor Toolkit extension is now active');

    // Create status bar items
    createStatusBarItems(context);

    // Register enable hot reload command
    let enableHotReloadCommand = vscode.commands.registerCommand('unity-cursor-toolkit.enableHotReload', () => {
        enableHotReload();
        vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Enabled');
        updateStatusBarItems();
    });

    // Register disable hot reload command
    let disableHotReloadCommand = vscode.commands.registerCommand('unity-cursor-toolkit.disableHotReload', () => {
        disableHotReload();
        vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Disabled');
        updateStatusBarItems();
    });

    // Register install unity script command
    let installUnityCommand = vscode.commands.registerCommand('unity-cursor-toolkit.installUnityScript', async () => {
        await installUnityScript();
    });

    // Register select project command
    let selectProjectCommand = vscode.commands.registerCommand('unity-cursor-toolkit.selectUnityProject', async () => {
        await selectUnityProject();
    });

    context.subscriptions.push(enableHotReloadCommand, disableHotReloadCommand, installUnityCommand, selectProjectCommand);

    // Auto-enable when a Unity project is detected
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const assetsPath = path.join(folder.uri.fsPath, 'Assets');
            if (fs.existsSync(assetsPath)) {
                enableHotReload();
                updateStatusBarItems();
                break;
            }
        }
    }
}

// Create the status bar items
function createStatusBarItems(context: vscode.ExtensionContext) {
    // Hot Reload toggle button
    hotReloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    hotReloadStatusBarItem.command = 'unity-cursor-toolkit.toggleHotReload';
    context.subscriptions.push(hotReloadStatusBarItem);
    
    // Register toggle command
    let toggleHotReloadCommand = vscode.commands.registerCommand('unity-cursor-toolkit.toggleHotReload', () => {
        if (hotReloadEnabled) {
            disableHotReload();
            vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Disabled');
        } else {
            enableHotReload();
            vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Enabled');
        }
        updateStatusBarItems();
    });
    context.subscriptions.push(toggleHotReloadCommand);
    
    // Select Project button
    selectProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    selectProjectStatusBarItem.text = "$(file-directory) Select Unity Project";
    selectProjectStatusBarItem.tooltip = "Select a Unity project to install the Hot Reload script";
    selectProjectStatusBarItem.command = 'unity-cursor-toolkit.selectUnityProject';
    context.subscriptions.push(selectProjectStatusBarItem);
    
    // Install Script button
    installScriptStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    installScriptStatusBarItem.text = "$(cloud-download) Install Unity Script";
    installScriptStatusBarItem.tooltip = "Install the Hot Reload script to your Unity project";
    installScriptStatusBarItem.command = 'unity-cursor-toolkit.installUnityScript';
    context.subscriptions.push(installScriptStatusBarItem);
    
    // Initial update
    updateStatusBarItems();
}

// Update status bar items based on current state
function updateStatusBarItems() {
    if (hotReloadEnabled) {
        hotReloadStatusBarItem.text = "$(sync) Hot Reload: On";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is enabled. Click to disable.";
        hotReloadStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        hotReloadStatusBarItem.text = "$(sync-ignored) Hot Reload: Off";
        hotReloadStatusBarItem.tooltip = "Unity Hot Reload is disabled. Click to enable.";
        hotReloadStatusBarItem.backgroundColor = undefined;
    }
    
    // Show all items
    hotReloadStatusBarItem.show();
    selectProjectStatusBarItem.show();
    installScriptStatusBarItem.show();
}

function enableHotReload() {
    if (hotReloadEnabled) {
        return;
    }

    hotReloadEnabled = true;
    
    // Watch for CS file changes
    fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.cs");
    fileWatcher.onDidChange(uri => {
        console.log(`File changed: ${uri.fsPath}`);
        triggerUnityRefresh();
    });
    
    // Watch for solution and project files
    solutionWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,csproj}");
    solutionWatcher.onDidChange(uri => {
        console.log(`Solution/project file changed: ${uri.fsPath}`);
        handleSolutionChange(uri);
    });

    // Try to connect to Unity
    connectToUnity();
    
    // Update status bar
    updateStatusBarItems();
}

function disableHotReload() {
    if (!hotReloadEnabled) {
        return;
    }

    hotReloadEnabled = false;
    
    // Dispose watchers
    if (fileWatcher) {
        fileWatcher.dispose();
        fileWatcher = undefined;
    }
    
    if (solutionWatcher) {
        solutionWatcher.dispose();
        solutionWatcher = undefined;
    }
    
    // Disconnect from Unity
    if (socketClient) {
        socketClient.end();
        socketClient = undefined;
    }
    
    // Update status bar
    updateStatusBarItems();
}

function connectToUnity() {
    if (socketClient) {
        try {
            socketClient.destroy();
        } catch (e) {
            console.error('Error destroying existing socket:', e);
        }
        socketClient = undefined;
    }
    
    // Try each port in sequence
    tryConnectToPort(0);
}

function tryConnectToPort(portIndex: number) {
    if (portIndex >= ALTERNATIVE_PORTS.length) {
        console.error('Failed to connect to Unity on any port');
        vscode.window.showErrorMessage('Failed to connect to Unity. Make sure Unity is running and the Hot Reload script is installed.');
        return;
    }
    
    const port = ALTERNATIVE_PORTS[portIndex];
    console.log(`Trying to connect to Unity on port ${port}...`);
    
    socketClient = new net.Socket();
    
    socketClient.on('error', (error) => {
        console.log(`Connection error on port ${port}: ${error.message}`);
        socketClient?.destroy();
        socketClient = undefined;
        
        // Try the next port
        tryConnectToPort(portIndex + 1);
    });
    
    socketClient.on('close', () => {
        console.log('Socket connection closed');
        socketClient = undefined;
        // Try to reconnect after a delay if hot reload is still enabled
        if (hotReloadEnabled) {
            setTimeout(connectToUnity, 5000);
        }
    });
    
    // Set a connection timeout to try other ports
    socketClient.setTimeout(2000);
    socketClient.on('timeout', () => {
        console.log(`Connection timeout on port ${port}`);
        socketClient?.destroy();
        socketClient = undefined;
        
        // Try the next port
        tryConnectToPort(portIndex + 1);
    });
    
    socketClient.connect(port, 'localhost', () => {
        console.log(`Connected to Unity Editor on port ${port}`);
        currentPort = port;
        
        // Reset the timeout once connected
        socketClient?.setTimeout(0);
        
        // Update status message
        vscode.window.setStatusBarMessage(`Connected to Unity on port ${port}`, 5000);
    });
}

function triggerUnityRefresh() {
    if (!socketClient || socketClient.destroyed) {
        connectToUnity();
        return;
    }
    
    try {
        socketClient.write(JSON.stringify({
            command: 'refresh',
            timestamp: new Date().getTime()
        }));
    } catch (error) {
        console.error('Error sending refresh command:', error);
        connectToUnity();
    }
}

function handleSolutionChange(uri: vscode.Uri) {
    const filePath = uri.fsPath;
    
    // Parse solution/project files
    if (filePath.endsWith('.sln')) {
        console.log('Solution file changed, triggering Unity refresh');
    } else if (filePath.endsWith('.csproj')) {
        console.log('Project file changed, triggering Unity refresh');
    }
    
    // Trigger Unity refresh
    triggerUnityRefresh();
}

// Function to install the Unity script into a Unity project
async function installUnityScript() {
    // Check if there are workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        // No workspace folders, offer to select a project
        const selectProject = 'Select Unity Project';
        const result = await vscode.window.showErrorMessage(
            'No workspace folder is open. Please open a Unity project first or select one now.',
            selectProject
        );
        
        if (result === selectProject) {
            await selectUnityProject();
        }
        return;
    }

    // Try to detect Unity projects in the workspace
    const unityProjects: { label: string; uri: vscode.Uri }[] = [];
    
    for (const folder of workspaceFolders) {
        const assetsPath = path.join(folder.uri.fsPath, 'Assets');
        if (fs.existsSync(assetsPath)) {
            unityProjects.push({
                label: folder.name,
                uri: folder.uri
            });
        }
    }

    let targetFolder: vscode.Uri;
    
    if (unityProjects.length === 0) {
        // No Unity projects detected, offer to select a project
        const selectProject = 'Select Unity Project';
        const result = await vscode.window.showErrorMessage(
            'No Unity project detected in the workspace. A Unity project should have an "Assets" folder.',
            selectProject
        );
        
        if (result === selectProject) {
            await selectUnityProject();
        }
        return;
    } else if (unityProjects.length === 1) {
        targetFolder = unityProjects[0].uri;
    } else {
        // If multiple Unity projects are found, let the user choose
        const selectExternal = { label: "Browse for Unity Project...", uri: vscode.Uri.file('') };
        const options = [...unityProjects, selectExternal];
        
        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select a Unity project to install the hot reload script'
        });
        
        if (!selected) {
            return; // User cancelled
        }
        
        if (selected === selectExternal) {
            // User wants to browse for a project
            const projectUri = await selectUnityProject();
            if (!projectUri) {
                return; // User cancelled
            }
            targetFolder = projectUri;
        } else {
            targetFolder = selected.uri;
        }
    }

    // Get the path to the extension's resources
    const extensionPath = vscode.extensions.getExtension('unity-cursor-toolkit')?.extensionPath || 
                          path.join(__dirname, '..');
    const sourceScriptPath = path.join(extensionPath, 'unity-assets', 'HotReloadHandler.cs');
    
    // Check if the script exists
    if (!fs.existsSync(sourceScriptPath)) {
        vscode.window.showErrorMessage(`Could not find the Unity script at ${sourceScriptPath}`);
        return;
    }
    
    // Create Editor folder if it doesn't exist
    const editorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');
    if (!fs.existsSync(editorPath)) {
        try {
            fs.mkdirSync(editorPath, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create Editor folder: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    }
    
    // Copy the script file
    const destScriptPath = path.join(editorPath, 'HotReloadHandler.cs');
    try {
        fs.copyFileSync(sourceScriptPath, destScriptPath);
        vscode.window.showInformationMessage(
            `Successfully installed Unity Toolkit script to ${destScriptPath}. Please restart Unity if it's currently running.`,
            'Open Script'
        ).then(selection => {
            if (selection === 'Open Script') {
                vscode.workspace.openTextDocument(destScriptPath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to copy script file: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Function to select a Unity project using file dialog
async function selectUnityProject(): Promise<vscode.Uri | undefined> {
    // Show folder picker dialog
    const options: vscode.OpenDialogOptions = {
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: 'Select Unity Project Folder',
        title: 'Select Unity Project Root Folder'
    };
    
    const folderUri = await vscode.window.showOpenDialog(options);
    if (!folderUri || folderUri.length === 0) {
        return undefined; // User cancelled
    }
    
    const selectedFolder = folderUri[0];
    const assetsPath = path.join(selectedFolder.fsPath, 'Assets');
    
    // Verify it's a Unity project
    if (!fs.existsSync(assetsPath)) {
        const tryAnyway = 'Install Anyway';
        const result = await vscode.window.showWarningMessage(
            `The selected folder doesn't appear to be a Unity project (no Assets folder found). Do you want to install anyway?`,
            tryAnyway,
            'Cancel'
        );
        
        if (result !== tryAnyway) {
            return undefined;
        }
    }
    
    // If this is a Unity project, we can proceed with installation
    const extensionPath = vscode.extensions.getExtension('unity-cursor-toolkit')?.extensionPath || 
                        path.join(__dirname, '..');
    const sourceScriptPath = path.join(extensionPath, 'unity-assets', 'HotReloadHandler.cs');
    
    // Check if the script exists
    if (!fs.existsSync(sourceScriptPath)) {
        vscode.window.showErrorMessage(`Could not find the Unity script at ${sourceScriptPath}`);
        return undefined;
    }
    
    // Create Editor folder if it doesn't exist
    const editorPath = path.join(selectedFolder.fsPath, 'Assets', 'Editor');
    if (!fs.existsSync(editorPath)) {
        try {
            fs.mkdirSync(editorPath, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create Editor folder: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }
    
    // Copy the script file
    const destScriptPath = path.join(editorPath, 'HotReloadHandler.cs');
    try {
        fs.copyFileSync(sourceScriptPath, destScriptPath);
        vscode.window.showInformationMessage(
            `Successfully installed Unity Toolkit script to ${destScriptPath}. Please restart Unity if it's currently running.`,
            'Open Script'
        ).then(selection => {
            if (selection === 'Open Script') {
                vscode.workspace.openTextDocument(destScriptPath).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            }
        });
        
        return selectedFolder;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to copy script file: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

export function deactivate() {
    disableHotReload();
    
    // Clean up status bar items
    if (hotReloadStatusBarItem) {
        hotReloadStatusBarItem.dispose();
    }
    
    if (selectProjectStatusBarItem) {
        selectProjectStatusBarItem.dispose();
    }
    
    if (installScriptStatusBarItem) {
        installScriptStatusBarItem.dispose();
    }
} 