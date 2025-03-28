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
 * Main function to handle Unity project setup
 * This function manages the entire process of selecting a project and installing the script
 * following the sequential flow from the instructions
 * @returns true if setup was successful, false if there was an error or user cancelled
 */
export async function handleUnityProjectSetup(): Promise<boolean> {
    try {
        // Step 1: Check if the user has a linked project
        const linkedProject = checkLinkedProject();

        // If there's a valid linked project, ask user if they want to use it
        if (linkedProject) {
            const useExisting = await promptUseExistingProject(linkedProject);
            if (useExisting) {
                // User wants to use existing project - install script
                return await installScriptToProject(linkedProject);
            }
            // User wants to select a new project, continue with selection
        }

        // Step 2: If no valid linked project or user wants to change, find a project
        const targetFolder = await findUnityProject();
        if (!targetFolder) {
            return false; // No project selected
        }

        // Step 3: Save the project URI to configuration
        saveCurrentProjectUri(targetFolder);

        // Step 4: Install the script to the project
        return await installScriptToProject(targetFolder);
    } catch (error) {
        console.error('Error in Unity project setup:', error);
        vscode.window.showErrorMessage(`Failed to set up Unity project: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Check for existing linked project and verify it's valid
 * @returns The valid project URI or undefined if none exists
 */
function checkLinkedProject(): vscode.Uri | undefined {
    try {
        const savedProjectUri = getCurrentProjectUri();
        if (!savedProjectUri) {
            return undefined;
        }

        // Check if the project still exists and has an Assets folder
        return fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets')) ? savedProjectUri : undefined;
    } catch (error) {
        console.error('Error checking linked project:', error);
        return undefined;
    }
}

/**
 * Prompt the user to use an existing project or select a new one
 * @param projectUri The URI of the existing project
 * @returns true if user wants to use existing project, false otherwise
 */
async function promptUseExistingProject(projectUri: vscode.Uri): Promise<boolean> {
    const useExisting = 'Use Existing Project';
    const selectNew = 'Select New Project';

    const result = await vscode.window.showInformationMessage(
        `Found existing Unity project at: ${projectUri.fsPath}. Use this project?`,
        useExisting,
        selectNew
    );

    return result === useExisting;
}

/**
 * Find a Unity project through workspace or external selection
 * @returns The selected project URI or undefined if none selected
 */
async function findUnityProject(): Promise<vscode.Uri | undefined> {
    // Check if there are workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        // No workspace folders, go directly to external project selection
        return await selectExternalProject();
    }

    // Find Unity projects in the workspace
    const unityProjects = findWorkspaceUnityProjects(workspaceFolders);

    // Handle project selection based on what we found
    if (unityProjects.length === 0) {
        // No Unity projects detected, go to external project selection
        return await selectExternalProject();
    } else if (unityProjects.length === 1) {
        // Only one project found, use it directly
        return unityProjects[0].uri;
    } else {
        // Multiple projects found, let user choose
        return await selectFromMultipleProjects(unityProjects);
    }
}

/**
 * Find all Unity projects in the workspace folders
 * @param workspaceFolders The VSCode workspace folders
 * @returns Array of detected Unity projects
 */
function findWorkspaceUnityProjects(workspaceFolders: readonly vscode.WorkspaceFolder[]): { label: string; uri: vscode.Uri }[] {
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

    return unityProjects;
}

/**
 * Let user select from multiple Unity projects found in workspace
 * @param unityProjects Array of detected Unity projects
 * @returns Selected project URI or undefined if cancelled
 */
async function selectFromMultipleProjects(unityProjects: { label: string; uri: vscode.Uri }[]): Promise<vscode.Uri | undefined> {
    // Add option to browse for external project
    const selectExternal = { label: "Browse for Unity Project...", uri: vscode.Uri.file('') };
    const options = [...unityProjects, selectExternal];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select a Unity project for hot reload'
    });

    if (!selected) {
        return undefined; // User cancelled
    }

    if (selected === selectExternal) {
        // User wants to browse for a project
        return await selectExternalProject();
    } else {
        return selected.uri;
    }
}

/**
 * Select an external Unity project using file dialog
 * @returns Selected project URI or undefined if cancelled
 */
async function selectExternalProject(): Promise<vscode.Uri | undefined> {
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

        return selectedFolder;
    } catch (error) {
        console.error('Error in external project selection:', error);
        vscode.window.showErrorMessage(`Failed to select external project: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Install the script to a specific Unity project
 * @param targetFolder The target Unity project URI
 * @returns true if installation successful, false otherwise
 */
async function installScriptToProject(targetFolder: vscode.Uri): Promise<boolean> {
    try {
        // Find the source script path
        const sourceScriptPath = findSourceScriptPath();
        if (!sourceScriptPath) {
            return false;
        }

        // Create Editor folder if it doesn't exist
        const editorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');
        if (!fs.existsSync(editorPath)) {
            fs.mkdirSync(editorPath, { recursive: true });
        }

        // Copy the script file
        const destScriptPath = path.join(editorPath, 'HotReloadHandler.cs');
        fs.copyFileSync(sourceScriptPath, destScriptPath);

        // Show success message with option to open script
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
        console.error('Error installing script:', error);
        vscode.window.showErrorMessage(`Failed to install script: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Find the path to the source script file
 * @returns Path to the source script or undefined if not found
 */
function findSourceScriptPath(): string | undefined {
    // Get the path to the extension's resources
    const extensionPath = vscode.extensions.getExtension('rankupgames.unity-cursor-toolkit')?.extensionPath;
    let possiblePaths: string[] = [];

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
            return testPath;
        }
    }

    // If we get here, script was not found
    vscode.window.showErrorMessage(`Could not find the Unity script. Searched paths: ${possiblePaths.join(', ')}`);
    return undefined;
}

// ===== EXPORTED CHECKER FUNCTIONS =====

/**
 * Check if we already have a linked Unity project
 * @returns true if a project is linked and still exists with a valid Assets folder
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

// ===== GETTERS AND SETTERS =====

/**
 * Get the path to the linked project if one exists
 * @returns The project path or undefined if no valid project is linked
 */
export function getLinkedProjectPath(): string | undefined {
    try {
        const savedProjectUri = getCurrentProjectUri();
        if (!savedProjectUri) {
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

/**
 * Get the current project URI from configuration
 * @returns The project URI or undefined if none is set
 */
export function getCurrentProjectUri(): vscode.Uri | undefined {
    try {
        const config = vscode.workspace.getConfiguration();
        const uriString = config.get<string>(CURRENT_PROJECT_KEY);
        if (!uriString) {
            return undefined;
        }

        return vscode.Uri.parse(uriString);
    } catch (error) {
        console.error('Failed to get current project URI:', error);
        return undefined;
    }
}

/**
 * Save the current project URI to workspace configuration
 * @param projectUri The project URI to save
 */
function saveCurrentProjectUri(projectUri: vscode.Uri): void {
    try {
        // Save the project URI to configuration
        const config = vscode.workspace.getConfiguration();
        const uriString = projectUri.toString();

        // Use global scope instead of workspace scope to ensure persistence
        config.update(CURRENT_PROJECT_KEY, uriString, vscode.ConfigurationTarget.Global);
    } catch (error) {
        console.error('Failed to save current project URI:', error);
        vscode.window.showErrorMessage(`Failed to save project configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
}