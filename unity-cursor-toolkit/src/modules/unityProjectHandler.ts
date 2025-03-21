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

/**
 * Check if we already have a linked Unity project
 * Returns true if a project is linked and still exists with a valid Assets folder
 */
export function hasLinkedUnityProject(): boolean {
    try {
        const savedProjectUri = getCurrentProjectUri();
        if (!savedProjectUri) {
            return false;
        }

        // Check if the project still exists and has an Assets folder
        return fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets'));
    } catch (error) {
        console.error('Error checking linked project:', error);
        return false;
    }
}

/**
 * Get the path to the linked project if one exists
 * Returns the project path or undefined if no valid project is linked
 */
export function getLinkedProjectPath(): string | undefined {
    try {
        const savedProjectUri = getCurrentProjectUri();
		if (!savedProjectUri) {
			vscode.window.showErrorMessage('No Unity project linked. Please select a project to link.');
            return undefined;
		}

		// Get the project path
        const projectPath = savedProjectUri.fsPath;

        // Check if the project still exists and has an Assets folder
        const assetsPath = path.join(projectPath, 'Assets');
        const exists = fs.existsSync(assetsPath);

        return exists ? projectPath : undefined;
    } catch (error) {
        console.error('Error getting linked project path:', error);
        return undefined;
    }
}

/**
 * Main function to handle Unity project setup
 * This single function manages the entire process of selecting a project and installing the script
 * @returns true if setup was successful, false if there was an error or user cancelled
 */
export async function handleUnityProjectSetup(): Promise<boolean> {
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
                return false; // User cancelled
            }

            if (selected === selectExternal) {
                // User wants to browse for a project
                const projectUri = await selectAndInstallExternalProject();
                return !!projectUri; // Convert to boolean
            } else {
                targetFolder = selected.uri;
            }
        }

        if (targetFolder) {
            // Save the selected project URI
            saveCurrentProjectUri(targetFolder);

            // Install the script to the project
            return await installScriptToProject(targetFolder);
        }

        return false; // No target folder selected
    } catch (error) {
        console.error('Error in Unity project setup:', error);
        vscode.window.showErrorMessage(`Failed to set up Unity project: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Helper function to select and install to an external project
 */
async function selectAndInstallExternalProject(): Promise<vscode.Uri | undefined> {
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

        // Save the selected project URI
        saveCurrentProjectUri(selectedFolder);

        // Install the script to the selected project
        const success = await installScriptToProject(selectedFolder);
        return success ? selectedFolder : undefined;
    } catch (error) {
        console.error('Error in external project selection:', error);
        vscode.window.showErrorMessage(`Failed to select external project: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Save the current project URI to workspace configuration
 */
function saveCurrentProjectUri(projectUri: vscode.Uri): void {
    try {
        // Save the project URI to configuration
        const config = vscode.workspace.getConfiguration();
        const uriString = projectUri.toString();

        // Use global scope instead of workspace scope to ensure persistence
        config.update(CURRENT_PROJECT_KEY, uriString, vscode.ConfigurationTarget.Global);

        // Verify it was saved correctly
        const savedUri = config.get<string>(CURRENT_PROJECT_KEY);
    } catch (error) {
        console.error('Failed to save current project URI:', error);
    }
}

/**
 * Get the current project URI from configuration
 */
export function getCurrentProjectUri(): vscode.Uri | undefined {
    try {
        const config = vscode.workspace.getConfiguration();
        const uriString = config.get<string>(CURRENT_PROJECT_KEY);
        if (!uriString) {
			vscode.window.showErrorMessage('Couldn\'t get current project URI. Please select a project to link.');
            return undefined;
        }

        return vscode.Uri.parse(uriString);
    } catch (error) {
        console.error('Failed to get current project URI:', error);
        return undefined;
    }
}

/**
 * Install the script to a specific Unity project
 */
async function installScriptToProject(targetFolder: vscode.Uri): Promise<boolean> {
    // Get the path to the extension's resources
    const extensionPath = vscode.extensions.getExtension('rankupgames.unity-cursor-toolkit')?.extensionPath;

    // Try different paths to find the script file
    let sourceScriptPath = '';
    let possiblePaths = [];

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
        return false;
    }

    // Create Editor folder if it doesn't exist
    const editorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');
    if (fs.existsSync(editorPath) === false) {
        try {
            fs.mkdirSync(editorPath, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create Editor folder: ${error instanceof Error ? error.message : String(error)}`);
            return false;
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
        return true;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to copy script file: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Check if the hot reload script is already installed in the linked project
 * @returns true if the script is installed, false otherwise
 */
export function isScriptInstalledInLinkedProject(): boolean {
    try {
        const projectPath = getLinkedProjectPath();
        if (!projectPath) {
            return false;
        }

        const scriptPath = path.join(projectPath, 'Assets', 'Editor', 'HotReloadHandler.cs');
        return fs.existsSync(scriptPath);
    } catch (error) {
        console.error('Error checking if script is installed:', error);
        return false;
    }
}

/**
 * Get the path to the hot reload script in the linked project if it exists
 * @returns Path to the script or undefined if not found
 */
export function getScriptPathInLinkedProject(): string | undefined {
    try {
        const projectPath = getLinkedProjectPath();
        if (!projectPath) {
            return undefined;
        }

        const scriptPath = path.join(projectPath, 'Assets', 'Editor', 'HotReloadHandler.cs');
        return fs.existsSync(scriptPath) ? scriptPath : undefined;
    } catch (error) {
        console.error('Error getting script path:', error);
        return undefined;
    }
}