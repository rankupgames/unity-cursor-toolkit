import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

// Port for communication with Unity Editor
const UNITY_HOT_RELOAD_PORT = 55500;
let socketClient: net.Socket | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let solutionWatcher: vscode.FileSystemWatcher | undefined;
let hotReloadEnabled = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('Unity Cursor Toolkit extension is now active');

    // Register enable hot reload command
    let enableHotReloadCommand = vscode.commands.registerCommand('unity-cursor-toolkit.enableHotReload', () => {
        enableHotReload();
        vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Enabled');
    });

    // Register disable hot reload command
    let disableHotReloadCommand = vscode.commands.registerCommand('unity-cursor-toolkit.disableHotReload', () => {
        disableHotReload();
        vscode.window.showInformationMessage('Unity Toolkit: Hot Reload Disabled');
    });

    // Register install unity script command
    let installUnityCommand = vscode.commands.registerCommand('unity-cursor-toolkit.installUnityScript', async () => {
        await installUnityScript();
    });

    context.subscriptions.push(enableHotReloadCommand, disableHotReloadCommand, installUnityCommand);

    // Auto-enable when a Unity project is detected
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const assetsPath = path.join(folder.uri.fsPath, 'Assets');
            if (fs.existsSync(assetsPath)) {
                enableHotReload();
                break;
            }
        }
    }
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
}

function connectToUnity() {
    if (socketClient) {
        socketClient.end();
    }

    socketClient = new net.Socket();
    
    socketClient.on('error', (error) => {
        console.error('Socket error:', error);
        // Try to reconnect after a delay
        setTimeout(connectToUnity, 5000);
    });
    
    socketClient.on('close', () => {
        console.log('Socket connection closed');
        socketClient = undefined;
        // Try to reconnect after a delay if hot reload is still enabled
        if (hotReloadEnabled) {
            setTimeout(connectToUnity, 5000);
        }
    });
    
    socketClient.connect(UNITY_HOT_RELOAD_PORT, 'localhost', () => {
        console.log('Connected to Unity Editor');
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
            timestamp: Date.now()
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
        vscode.window.showErrorMessage('No workspace folder is open. Please open a Unity project first.');
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
        vscode.window.showErrorMessage('No Unity project detected in the workspace. A Unity project should have an "Assets" folder.');
        return;
    } else if (unityProjects.length === 1) {
        targetFolder = unityProjects[0].uri;
    } else {
        // If multiple Unity projects are found, let the user choose
        const selected = await vscode.window.showQuickPick(unityProjects, {
            placeHolder: 'Select a Unity project to install the hot reload script'
        });
        
        if (!selected) {
            return; // User cancelled
        }
        
        targetFolder = selected.uri;
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

export function deactivate() {
    disableHotReload();
} 