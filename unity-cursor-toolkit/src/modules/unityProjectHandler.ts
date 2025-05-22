/**
 * Unity Project Handler - Manages Unity project detection, selection, and linking
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Configuration key for storing the current project URI
const CURRENT_PROJECT_KEY = 'unityCursorToolkit.currentProjectUri';

let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Initialize the module with the extension context.
 * @param context The extension context.
 */
export function initializeUnityProjectHandler(context: vscode.ExtensionContext) {
    extensionContext = context;
}

/**
 * Check if we already have a linked Unity project
 * Returns true if a project is linked and still exists with a valid Assets folder
 */
export function hasLinkedUnityProject(): boolean {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized.');
        return false;
    }
    try {
        const savedProjectUri = getCurrentProjectUri();
        if (!savedProjectUri) {
            return false;
        }

        // Check if the project still exists and has an Assets folder
        return fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets'));
    } catch (error) {
        console.error('[UnityProjectHandler] Error checking linked project:', error);
        return false;
    }
}

/**
 * Get the path to the linked project if one exists
 * Returns the project path or undefined if no valid project is linked
 */
export function getLinkedProjectPath(): string | undefined {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for getLinkedProjectPath.');
        return undefined;
    }
    try {
        const savedProjectUri = getCurrentProjectUri();
		if (!savedProjectUri) {
			console.log('[UnityProjectHandler] No Unity project currently linked in this session.');
            return undefined;
		}

		// Get the project path
        const projectPath = savedProjectUri.fsPath;

        // Check if the project still exists and has an Assets folder
        const assetsPath = path.join(projectPath, 'Assets');
        const exists = fs.existsSync(assetsPath);

        return exists ? projectPath : undefined;
    } catch (error) {
        console.error('[UnityProjectHandler] Error getting linked project path:', error);
        return undefined;
    }
}

/**
 * Main function to handle Unity project setup
 * This single function manages the entire process of selecting a project and installing the script
 * @returns true if setup was successful, false if there was an error or user cancelled
 */
export async function handleUnityProjectSetup(): Promise<boolean> {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for handleUnityProjectSetup.');
        vscode.window.showErrorMessage('Unity Toolkit Error: Extension context not available. Please restart VS Code.');
        return false;
    }
    try {
        // First try to get the current project from configuration
        const savedProjectUri = getCurrentProjectUri();

        // If we have a saved project and it still exists with an Assets folder, use it directly
        if (savedProjectUri && fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets'))) {
            const useExisting = 'Use Existing Project';
            const selectNew = 'Select New Project';

            const result = await vscode.window.showInformationMessage(
                `Found existing Unity project at: ${savedProjectUri.fsPath}. Use this project?`,
                useExisting,
                selectNew
            );

            if (result === useExisting) {
                // Use the existing project and install/update the script
                return await installScriptToProject(savedProjectUri);
            }
            // If user wants to select new, continue with selection process
        }

        // Check if there are workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            // No workspace folders, go directly to external project selection
            const projectUri = await selectAndInstallExternalProject();
            return !!projectUri; // Convert to boolean
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

        // Handle project selection based on what we found
        let targetFolder: vscode.Uri | undefined;

        if (unityProjects.length === 0) {
            // No Unity projects detected, go to external project selection
            const projectUri = await selectAndInstallExternalProject();
            return !!projectUri; // Convert to boolean
        } else if (unityProjects.length === 1) {
            // Only one project found, use it directly
            targetFolder = unityProjects[0].uri;
        } else {
            // Multiple projects found, let user choose
            const selectExternal = { label: "Browse for Unity Project...", uri: vscode.Uri.file('') };
            const options = [...unityProjects, selectExternal];

            const selected = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select a Unity project for hot reload'
            });

            if (!selected) {
                console.log('[UnityProjectHandler] User cancelled project selection from multiple projects.');
                return false; // User cancelled
            }

            if (selected === selectExternal) {
                // User wants to browse for a project
                const projectUri = await selectAndInstallExternalProject();
                if (!projectUri) console.log('[UnityProjectHandler] User cancelled or failed external project selection.');
                return !!projectUri; // Convert to boolean
            } else {
                targetFolder = selected.uri;
            }
        }

        if (targetFolder) {
            console.log(`[UnityProjectHandler] Project selected: ${targetFolder.fsPath}`);
            // Save the selected project URI
            saveCurrentProjectUri(targetFolder);

            // Install the script to the project
            return await installScriptToProject(targetFolder);
        }

        console.log('[UnityProjectHandler] No target folder was ultimately selected in handleUnityProjectSetup.');
        return false; // No target folder selected
    } catch (error) {
        console.error('[UnityProjectHandler] Error in Unity project setup:', error);
        vscode.window.showErrorMessage(`Failed to set up Unity project: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Helper function to select and install to an external project
 */
async function selectAndInstallExternalProject(): Promise<vscode.Uri | undefined> {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for selectAndInstallExternalProject.');
        // No user message here as it's an internal flow, error will be shown by caller.
        return undefined;
    }
    try {
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
            console.log('[UnityProjectHandler] User cancelled external project folder selection dialog.');
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
                console.log('[UnityProjectHandler] User chose not to install in a folder without an Assets directory.');
                return undefined;
            }
        }

        // Save the selected project URI
        saveCurrentProjectUri(selectedFolder);

        // Install the script to the selected project
        const success = await installScriptToProject(selectedFolder);
        if (!success) console.log(`[UnityProjectHandler] Failed to install script to external project: ${selectedFolder.fsPath}`);
        return success ? selectedFolder : undefined;
    } catch (error) {
        console.error('[UnityProjectHandler] Error in external project selection:', error);
        vscode.window.showErrorMessage(`Failed to select external project: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Save the current project URI to workspace configuration
 */
function saveCurrentProjectUri(projectUri: vscode.Uri): void {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for saveCurrentProjectUri.');
        return;
    }
    try {
        // Save the project URI to configuration
        const uriString = projectUri.toString();

        // Use global scope instead of workspace scope to ensure persistence
        extensionContext.workspaceState.update(CURRENT_PROJECT_KEY, uriString);

        console.log(`[UnityProjectHandler] Saved project URI to workspaceState: ${uriString}`);

        // Verify it was saved correctly
        const savedUri = extensionContext.workspaceState.get<string>(CURRENT_PROJECT_KEY);
        if (savedUri !== uriString) {
            console.warn('[UnityProjectHandler] Project URI may not have saved correctly to workspaceState.');
        }
    } catch (error) {
        console.error('[UnityProjectHandler] Failed to save current project URI to workspaceState:', error);
    }
}

/**
 * Get the current project URI from configuration
 */
export function getCurrentProjectUri(): vscode.Uri | undefined {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for getCurrentProjectUri.');
        return undefined;
    }
    try {
        const uriString = extensionContext.workspaceState.get<string>(CURRENT_PROJECT_KEY);
        if (!uriString) {
            console.log('[UnityProjectHandler] No project URI found in workspaceState.');
            return undefined;
        }

        return vscode.Uri.parse(uriString);
    } catch (error) {
        console.error('[UnityProjectHandler] Failed to get current project URI from workspaceState:', error);
        return undefined;
    }
}

/**
 * Install the script to a specific Unity project
 */
async function installScriptToProject(targetFolder: vscode.Uri): Promise<boolean> {
    console.log(`[UnityProjectHandler] Attempting to install script to: ${targetFolder.fsPath}`);
    // Get the path to the extension's resources
    const extensionPath = vscode.extensions.getExtension('rankupgames.unity-cursor-toolkit')?.extensionPath;

    // Try different paths to find the script file
    let sourceScriptPath = '';
    let possiblePaths: string[] = []; // Changed const to let

    if (extensionPath) {
        // Extension is installed - use extension path
        possiblePaths = [
            path.join(extensionPath, 'unity-assets', 'HotReloadHandler.cs'),
            path.join(extensionPath, 'out', 'unity-assets', 'HotReloadHandler.cs')
        ];
    } else {
        // Development environment - use relative paths
        const basePath = path.join(__dirname, '..', '..');
        possiblePaths = [
            path.join(basePath, 'unity-assets', 'HotReloadHandler.cs'),
            path.join(basePath, '..', 'unity-assets', 'HotReloadHandler.cs')
        ];
    }

    // Find the first path that exists
    for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
            sourceScriptPath = testPath;
            break;
        }
    }

    // Check if we found the script
    if (!sourceScriptPath || !fs.existsSync(sourceScriptPath)) {
        vscode.window.showErrorMessage(`Could not find the Unity script. Searched paths: ${possiblePaths.join(', ')}`);
        console.error(`[UnityProjectHandler] HotReloadHandler.cs script not found. Searched: ${possiblePaths.join('; ')}`);
        return false;
    }

    // Create Editor folder if it doesn't exist
    const editorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');
    if (fs.existsSync(editorPath) === false) {
        try {
            fs.mkdirSync(editorPath, { recursive: true });
        } catch (error) {
            console.error(`[UnityProjectHandler] Failed to create Editor folder at ${editorPath}:`, error);
            vscode.window.showErrorMessage(`Failed to create Editor folder: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    // Copy the script file
    const destScriptPath = path.join(editorPath, 'HotReloadHandler.cs');
    console.log(`[UnityProjectHandler] Copying script from ${sourceScriptPath} to ${destScriptPath}`);
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
        console.log(`[UnityProjectHandler] Successfully installed script to ${destScriptPath}.`);
        return true;
    } catch (error) {
        console.error(`[UnityProjectHandler] Failed to copy script file to ${destScriptPath}:`, error);
        vscode.window.showErrorMessage(`Failed to copy script file: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Check if the hot reload script is already installed in the linked project
 * @returns true if the script is installed, false otherwise
 */
export function isScriptInstalledInLinkedProject(): boolean {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for isScriptInstalledInLinkedProject.');
        return false;
    }
    try {
        const projectPath = getLinkedProjectPath();
        if (!projectPath) {
            return false;
        }

        const scriptPath = path.join(projectPath, 'Assets', 'Editor', 'HotReloadHandler.cs');
        return fs.existsSync(scriptPath);
    } catch (error) {
        console.error('[UnityProjectHandler] Error checking if script is installed:', error);
        return false;
    }
}

/**
 * Get the path to the hot reload script in the linked project if it exists
 * @returns Path to the script or undefined if not found
 */
export function getScriptPathInLinkedProject(): string | undefined {
    if (!extensionContext) {
        console.error('[UnityProjectHandler] Extension context not initialized for getScriptPathInLinkedProject.');
        return undefined;
    }
    try {
        const projectPath = getLinkedProjectPath();
        if (!projectPath) {
            return undefined;
        }

        const scriptPath = path.join(projectPath, 'Assets', 'Editor', 'HotReloadHandler.cs');
        return fs.existsSync(scriptPath) ? scriptPath : undefined;
    } catch (error) {
        console.error('[UnityProjectHandler] Error getting script path:', error);
        return undefined;
    }
}

/**
 * Clear the linked project URI from workspace state.
 * Called on extension deactivation to ensure session-like behavior if desired,
 * or can be adapted based on true session needs.
 */
export function clearLinkedProjectOnExit(): void {
    if (!extensionContext) {
        console.warn('[UnityProjectHandler] Extension context not available during deactivation, cannot clear project URI.');
        return;
    }
    try {
        extensionContext.workspaceState.update(CURRENT_PROJECT_KEY, undefined);
        console.log('[UnityProjectHandler] Cleared linked project URI from workspaceState.');
    } catch (error) {
        console.error('[UnityProjectHandler] Error clearing linked project URI from workspaceState:', error);
    }
}