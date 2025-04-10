/**
 * Unity Project Handler - Manages Unity project detection, selection, and linking
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Changes: Added selectAndAttachProject function for direct selection flow triggered by status bar.
 *          Deprecated handleUnityProjectSetup for direct user interaction.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Configuration key for storing the current project URI
const CURRENT_PROJECT_KEY = 'unityCursorToolkit.currentProjectUri';

// Add logger instance if needed for internal logging
// For now, we'll use console.
// let _logger: vscode.LogOutputChannel | null = null;
// export function setLogger(logger: vscode.LogOutputChannel) { _logger = logger; }

/**
 * Handles the user flow for selecting a Unity project (workspace or external)
 * and linking it + installing the script. Triggered directly by user action.
 * @returns true if selection, linking, and installation were successful, false otherwise.
 */
export async function selectAndAttachProject(): Promise<boolean> {
    try {
        // Step 1: Find/Select the project folder
        console.log("Starting Unity project selection...");
        const targetFolder = await findUnityProject();
        if (!targetFolder) {
            console.log('Unity project selection cancelled by user.');
            // No need for a message here, user explicitly cancelled the picker
            return false; // User cancelled selection
        }
        console.log(`User selected project folder: ${targetFolder.fsPath}`);

        // Step 2: Save the selected project URI to configuration
        saveCurrentProjectUri(targetFolder);
        // Optional: Show brief confirmation, the final message is usually enough
        // vscode.window.showInformationMessage(`Selected Unity project: ${targetFolder.fsPath}`);

        // Step 3: Install the script to the project
        const installSuccess = await installScriptToProject(targetFolder);
        if (!installSuccess) {
            // Error message shown within installScriptToProject
            console.error("Script installation failed.");
            return false;
        }

        // Optional: Verify script exists after install (if installScriptToProject might fail silently)
        const scriptPath = path.join(targetFolder.fsPath, 'Assets', 'Editor', 'HotReloadHandler.cs');
        if (!fs.existsSync(scriptPath)) {
             vscode.window.showErrorMessage(`Verification failed: Script not found at ${scriptPath} after installation attempt.`);
             console.error(`Script file not found at ${scriptPath} after supposedly successful installation.`);
             return false;
         }

        console.log(`Successfully linked and installed script for project: ${path.basename(targetFolder.fsPath)}`);
        // Let the command handler in extension.ts show the final user message
        return true;

    } catch (error) {
        console.error('Error selecting/attaching Unity project:', error);
        vscode.window.showErrorMessage(`Failed select or attach Unity project: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * @deprecated Use selectAndAttachProject for user-initiated selection.
 * Main function to handle Unity project setup (original flow)
 * This function manages the entire process of selecting a project and installing the script
 * following the sequential flow from the instructions
 * @returns true if setup was successful, false if there was an error or user cancelled
 */
export async function handleUnityProjectSetup(): Promise<boolean> {
    console.warn("handleUnityProjectSetup is deprecated for direct user interaction. Use selectAndAttachProject.");
     try {
        // Step 1: Check if the user has a linked project
        const linkedProject = checkLinkedProject();

        // If there's a valid linked project, ask user if they want to use it
        if (linkedProject) {
            const useExisting = await promptUseExistingProject(linkedProject);
            if (useExisting) {
                // User wants to use existing project - ensure script is installed
                 if (!isScriptInstalledInLinkedProject()) {
                    vscode.window.showInformationMessage(`Existing project ${path.basename(linkedProject.fsPath)} linked. Installing missing script...`);
                    return await installScriptToProject(linkedProject);
                 } else {
                     vscode.window.showInformationMessage(`Existing project ${path.basename(linkedProject.fsPath)} is already linked and script installed.`);
                     return true; // Already set up
                 }
            }
            // User wants to select a new project, fall through to selection
             vscode.window.showInformationMessage("Proceeding to select a new Unity project...");
        }

        // Step 2: Find/Select a new project
        const targetFolder = await findUnityProject();
        if (!targetFolder) {
            return false; // No project selected (cancelled)
        }

        // Step 3: Save the project URI to configuration
        saveCurrentProjectUri(targetFolder);

        // Step 4: Install the script to the project
        return await installScriptToProject(targetFolder);
    } catch (error) {
        console.error('Error in legacy Unity project setup:', error);
        vscode.window.showErrorMessage(`Failed to set up Unity project (legacy flow): ${error instanceof Error ? error.message : String(error)}`);
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
 * Guides the user through selecting a Unity project folder using QuickPick.
 * @returns The selected project URI or undefined if none selected/cancelled.
 */
async function findUnityProject(): Promise<vscode.Uri | undefined> {
    // Check if there are workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const unityProjectsInWorkspace = workspaceFolders ? findWorkspaceUnityProjects(workspaceFolders) : [];

    // Prepare QuickPick items
    const quickPickItems: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [];

    // Add workspace projects
    unityProjectsInWorkspace.forEach(p => {
        quickPickItems.push({
            label: `$(folder) ${p.label}`, // Icon + Workspace folder name
            description: p.uri.fsPath,     // Show full path
            uri: p.uri
        });
    });

    // Add browse option
    const browseOption: vscode.QuickPickItem & { uri?: vscode.Uri } = {
        label: "$(folder-opened) Browse for Unity Project Folder...",
        description: "Select a Unity project folder not in the current workspace",
        uri: undefined // Special marker for browse action
    };
    quickPickItems.push(browseOption);

    // Determine placeholder text
    let placeHolder = 'Select a Unity project to link';
    if (unityProjectsInWorkspace.length === 1) {
        placeHolder = `Use workspace project '${unityProjectsInWorkspace[0].label}' or browse?`;
    } else if (unityProjectsInWorkspace.length > 1) {
        placeHolder = 'Select a workspace project or browse for another';
    }

    // Show QuickPick
    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: placeHolder,
        matchOnDescription: true // Allow searching by path
    });

    // Handle selection
    if (!selectedItem) {
        return undefined; // User cancelled QuickPick
    }

    if (selectedItem === browseOption) {
        // User chose to browse
        return await selectExternalProject();
    } else {
        // User selected a workspace project
        if (!selectedItem.uri) { // Should not happen if selectedItem !== browseOption
             console.error("Internal error: Selected workspace project item has no URI.");
             return undefined;
         }
        // Optional safety check: Verify Assets folder exists
        const assetsPath = path.join(selectedItem.uri.fsPath, 'Assets');
        if (!fs.existsSync(assetsPath)) {
            vscode.window.showWarningMessage(`Selected folder '${selectedItem.label}' doesn't contain an 'Assets' folder. Please ensure it's the correct Unity project root directory.`);
            // Allow proceeding, but warn the user.
        }
        return selectedItem.uri;
    }
}

/**
 * Find all Unity projects in the workspace folders
 * @param workspaceFolders The VSCode workspace folders
 * @returns Array of detected Unity projects (label is workspace folder name)
 */
function findWorkspaceUnityProjects(workspaceFolders: readonly vscode.WorkspaceFolder[]): { label: string; uri: vscode.Uri }[] {
     const unityProjects: { label: string; uri: vscode.Uri }[] = [];
     for (const folder of workspaceFolders) {
         const assetsPath = path.join(folder.uri.fsPath, 'Assets');
         // Also check for ProjectSettings as a stronger indicator?
         // const settingsPath = path.join(folder.uri.fsPath, 'ProjectSettings');
         if (fs.existsSync(assetsPath)) { // && fs.existsSync(settingsPath)) {
             unityProjects.push({
                 label: folder.name, // Use workspace folder name as label
                 uri: folder.uri
             });
         }
     }
     return unityProjects;
}

/**
 * Select an external Unity project using file dialog
 * @returns Selected project URI or undefined if cancelled
 */
async function selectExternalProject(): Promise<vscode.Uri | undefined> {
    try {
        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: 'Select Unity Project Folder',
            title: 'Select Unity Project Root Folder (containing Assets, ProjectSettings, etc.)'
        };
        const folderUriArray = await vscode.window.showOpenDialog(options);
        if (!folderUriArray || folderUriArray.length === 0) {
            return undefined; // User cancelled dialog
        }

        const selectedFolder = folderUriArray[0];
        const assetsPath = path.join(selectedFolder.fsPath, 'Assets');

        // Verify it contains an Assets folder
        if (!fs.existsSync(assetsPath)) {
            const tryAnyway = 'Select Anyway';
            const changeFolder = 'Choose Different Folder';
            const result = await vscode.window.showWarningMessage(
                `Selected folder doesn't contain an 'Assets' directory. It might not be a valid Unity project root. Select anyway?`,
                 { modal: true }, // Force user choice
                 tryAnyway,
                 changeFolder
            );
            // If user clicks 'Change Folder' or closes the dialog, return undefined to allow re-picking
            if (result !== tryAnyway) {
                console.log("User chose not to select the folder without an Assets directory.");
                return undefined;
            }
            console.log("User selected folder without Assets directory anyway.");
        }
        return selectedFolder;
    } catch (error) {
        console.error('Error selecting external project:', error);
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
        const sourceScriptPath = findSourceScriptPath();
        if (!sourceScriptPath) {
            // Error message if script not found
            vscode.window.showErrorMessage("Could not find the source 'HotReloadHandler.cs' script within the extension files. Installation aborted.");
            return false;
        }
        console.log(`Source script found at: ${sourceScriptPath}`);

        const editorFolderPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');

        // Ensure Assets/Editor directory exists
        try {
            if (!fs.existsSync(editorFolderPath)) {
                console.log(`Editor folder not found at ${editorFolderPath}, creating...`);
                fs.mkdirSync(editorFolderPath, { recursive: true });
                console.log(`Created directory: ${editorFolderPath}`);
            }
        } catch (mkdirError) {
             console.error(`Failed to create Editor directory at ${editorFolderPath}:`, mkdirError);
             vscode.window.showErrorMessage(`Failed to create Assets/Editor folder. Check permissions for ${targetFolder.fsPath}. Installation aborted.`);
             return false;
        }

        // Copy the script file
        const destScriptPath = path.join(editorFolderPath, 'HotReloadHandler.cs');
        try {
             fs.copyFileSync(sourceScriptPath, destScriptPath);
             console.log(`Copied script from ${sourceScriptPath} to ${destScriptPath}`);
         } catch (copyError) {
             console.error(`Failed to copy script to ${destScriptPath}:`, copyError);
             vscode.window.showErrorMessage(`Failed to copy HotReloadHandler.cs script. Check file permissions. Error: ${copyError instanceof Error ? copyError.message : String(copyError)}. Installation aborted.`);
             return false;
         }

        // Show success message with option to open script (Non-modal)
        vscode.window.showInformationMessage(
            `Unity Toolkit script installed/updated in ${path.basename(targetFolder.fsPath)}. Please restart Unity if it's running.`, // Simplified message
            'Open Script Location' // Changed button text slightly
        ).then(selection => {
            if (selection === 'Open Script Location') {
                // Open the folder containing the script
                 vscode.env.openExternal(vscode.Uri.file(editorFolderPath));
                // Or open the script itself:
                // vscode.workspace.openTextDocument(destScriptPath).then(doc => {
                //     vscode.window.showTextDocument(doc);
                // });
            }
        });

        return true; // Assume success if no errors thrown
    } catch (error) {
        console.error('Unexpected error during script installation:', error);
        vscode.window.showErrorMessage(`Failed to install script due to an unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Find the path to the source script file within the extension.
 * @returns Path to the source script or undefined if not found
 */
function findSourceScriptPath(): string | undefined {
    // Get the path to the extension's installation directory
    const extension = vscode.extensions.getExtension('rankupgames.unity-cursor-toolkit');
    if (!extension) {
        console.error("Could not get extension context.");
        return undefined;
    }
    const extensionPath = extension.extensionPath;

    // Define potential locations relative to the extension path
    const possiblePaths = [
        path.join(extensionPath, 'unity-assets', 'HotReloadHandler.cs'),
        path.join(extensionPath, 'out', 'unity-assets', 'HotReloadHandler.cs') // If copied during build
        // Add more potential paths if the structure changes
    ];

    // Check if we might be in a development environment (heuristic)
    // Check for a file that typically exists in dev but not prod, like tsconfig.json at the root
    if (fs.existsSync(path.join(extensionPath, 'tsconfig.json'))) {
        console.log("Attempting development environment path resolution...");
        // Assumes this script is in unity-cursor-toolkit/src/modules
        const devBasePath = path.join(__dirname, '..', '..'); // Go up from src/modules to root
        possiblePaths.push(path.join(devBasePath, 'unity-assets', 'HotReloadHandler.cs'));
    }

    // Find the first path that exists
    for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
            console.log(`Found source script at: ${testPath}`);
            return testPath;
        }
    }

    console.error(`Could not find HotReloadHandler.cs. Searched paths: ${possiblePaths.join(', ')}`);
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