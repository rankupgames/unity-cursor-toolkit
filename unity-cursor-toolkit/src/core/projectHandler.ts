/**
 * Unity Project Handler -- Manages Unity project detection, selection, and linking
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const CURRENT_PROJECT_KEY = 'unityCursorToolkit.currentProjectUri';

const TOOLKIT_ROOT_SCRIPTS = ['HotReloadHandler.cs', 'ConsoleToCursor.cs', 'UnityCursorToolkit.Editor.asmdef'];

const TOOLKIT_SUB_SCRIPTS: Record<string, string[]> = {
	'Core': ['IToolHandler.cs', 'MCPToolAttribute.cs'],
	'HotReload': ['ILPatcher.cs'],
	'MCP': ['MCPBridge.cs', 'SceneTools.cs', 'AssetTools.cs', 'EditorControlTools.cs', 'ProjectInfoProvider.cs'],
	'Debug': ['DebugBridge.cs']
};

let extensionContext: vscode.ExtensionContext | undefined;

export const initializeUnityProjectHandler = (context: vscode.ExtensionContext): void => {
	extensionContext = context;
};

export const hasLinkedUnityProject = (): boolean => {
	if (extensionContext == null) {
		return false;
	}

	const savedProjectUri = getCurrentProjectUri();
	if (savedProjectUri == null) {
		return false;
	}

	return fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets'));
};

export const getLinkedProjectPath = (): string | undefined => {
	if (extensionContext == null) {
		return undefined;
	}

	const savedProjectUri = getCurrentProjectUri();
	if (savedProjectUri == null) {
		return undefined;
	}

	const projectPath = savedProjectUri.fsPath;
	return fs.existsSync(path.join(projectPath, 'Assets')) ? projectPath : undefined;
};

export const handleUnityProjectSetup = async (): Promise<boolean> => {
	if (extensionContext == null) {
		vscode.window.showErrorMessage('Unity Toolkit Error: Extension context not available.');
		return false;
	}

	const savedProjectUri = getCurrentProjectUri();

	if (savedProjectUri && fs.existsSync(path.join(savedProjectUri.fsPath, 'Assets'))) {
		const result = await vscode.window.showInformationMessage(
			`Found existing Unity project at: ${savedProjectUri.fsPath}. Use this project?`,
			'Use Existing Project',
			'Select New Project'
		);
		if (result === 'Use Existing Project') {
			return await installScriptToProject(savedProjectUri);
		}
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders == null || workspaceFolders.length === 0) {
		const projectUri = await selectAndInstallExternalProject();
		return projectUri != null;
	}

	const unityProjects: { label: string; uri: vscode.Uri }[] = [];
	for (const folder of workspaceFolders) {
		if (fs.existsSync(path.join(folder.uri.fsPath, 'Assets'))) {
			unityProjects.push({ label: folder.name, uri: folder.uri });
		}
	}

	let targetFolder: vscode.Uri | undefined;

	if (unityProjects.length === 0) {
		const projectUri = await selectAndInstallExternalProject();
		return projectUri != null;
	} else if (unityProjects.length === 1) {
		targetFolder = unityProjects[0].uri;
	} else {
		const selectExternal = { label: 'Browse for Unity Project...', uri: vscode.Uri.file('') };
		const options = [...unityProjects, selectExternal];
		const selected = await vscode.window.showQuickPick(options, {
			placeHolder: 'Select a Unity project for hot reload'
		});

		if (selected == null) {
			return false;
		}
		if (selected === selectExternal) {
			const projectUri = await selectAndInstallExternalProject();
			return projectUri != null;
		}
		targetFolder = selected.uri;
	}

	if (targetFolder) {
		saveCurrentProjectUri(targetFolder);
		return await installScriptToProject(targetFolder);
	}

	return false;
};

export const isScriptInstalledInLinkedProject = (): boolean => {
	if (extensionContext == null) {
		return false;
	}

	const projectPath = getLinkedProjectPath();
	if (projectPath == null) {
		return false;
	}

	const toolkitPath = path.join(projectPath, 'Assets', 'Editor', 'UnityCursorToolkit');
	return fs.existsSync(path.join(toolkitPath, 'HotReloadHandler.cs'))
		&& fs.existsSync(path.join(toolkitPath, 'MCP', 'MCPBridge.cs'));
};

export const clearLinkedProjectOnExit = (): void => {
	if (extensionContext == null) {
		return;
	}

	extensionContext.workspaceState.update(CURRENT_PROJECT_KEY, undefined);
};

export const getCurrentProjectUri = (): vscode.Uri | undefined => {
	if (extensionContext == null) {
		return undefined;
	}

	const uriString = extensionContext.workspaceState.get<string>(CURRENT_PROJECT_KEY);
	return uriString ? vscode.Uri.parse(uriString) : undefined;
};

const saveCurrentProjectUri = (projectUri: vscode.Uri): void => {
	if (extensionContext == null) {
		return;
	}

	extensionContext.workspaceState.update(CURRENT_PROJECT_KEY, projectUri.toString());
};

const selectAndInstallExternalProject = async (): Promise<vscode.Uri | undefined> => {
	if (extensionContext == null) {
		return undefined;
	}

	const folderUri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: 'Select Unity Project Folder',
		title: 'Select Unity Project Root Folder'
	});

	if (folderUri == null || folderUri.length === 0) {
		return undefined;
	}

	const selectedFolder = folderUri[0];
	const assetsPath = path.join(selectedFolder.fsPath, 'Assets');

	if (fs.existsSync(assetsPath) === false) {
		const result = await vscode.window.showWarningMessage(
			`The selected folder doesn't appear to be a Unity project (no Assets folder). Install anyway?`,
			'Install Anyway',
			'Cancel'
		);
		if (result !== 'Install Anyway') {
			return undefined;
		}
	}

	saveCurrentProjectUri(selectedFolder);
	const success = await installScriptToProject(selectedFolder);
	return success ? selectedFolder : undefined;
};

const installScriptToProject = async (targetFolder: vscode.Uri): Promise<boolean> => {
	const extensionPath = vscode.extensions.getExtension('rankupgames.unity-cursor-toolkit')?.extensionPath;
	const toolkitPath = path.join(targetFolder.fsPath, 'Assets', 'Editor', 'UnityCursorToolkit');

	await mkdirSafe(toolkitPath);

	let anyInstalled = false;
	let allSkipped = true;

	// Root-level scripts (source at unity-assets/<name>, dest at UnityCursorToolkit/<name>)
	for (const scriptName of TOOLKIT_ROOT_SCRIPTS) {
		const installed = await syncScript(extensionPath, scriptName, toolkitPath, scriptName);
		if (installed === true) { anyInstalled = true; allSkipped = false; }
		else if (installed === false) { allSkipped = false; }
	}

	// Subfolder scripts (source at unity-assets/<subfolder>/<name>, dest at UnityCursorToolkit/<subfolder>/<name>)
	for (const [subfolder, scripts] of Object.entries(TOOLKIT_SUB_SCRIPTS)) {
		const destDir = path.join(toolkitPath, subfolder);
		await mkdirSafe(destDir);

		for (const scriptName of scripts) {
			const sourceRelative = path.join(subfolder, scriptName);
			const installed = await syncScript(extensionPath, sourceRelative, destDir, scriptName);
			if (installed === true) { anyInstalled = true; allSkipped = false; }
			else if (installed === false) { allSkipped = false; }
		}
	}

	// Clean up old root-level scripts that were moved into UnityCursorToolkit/
	const oldEditorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');
	for (const oldScript of ['HotReloadHandler.cs', 'ConsoleToCursor.cs']) {
		const oldPath = path.join(oldEditorPath, oldScript);
		const oldMeta = oldPath + '.meta';
		if (fs.existsSync(oldPath)) {
			try {
				fs.unlinkSync(oldPath);
				if (fs.existsSync(oldMeta)) { fs.unlinkSync(oldMeta); }
				anyInstalled = true;
				allSkipped = false;
			} catch (err) {
				console.warn(`[ProjectHandler] Failed to remove old ${oldScript}: ${err}`);
			}
		}
	}

	if (allSkipped) {
		vscode.window.showInformationMessage('Unity Toolkit scripts already up to date.');
		return true;
	}

	if (anyInstalled) {
		vscode.window.showInformationMessage('Unity Toolkit scripts updated. Unity will recompile automatically.');
	}

	return true;
};

const mkdirSafe = async (dirPath: string): Promise<boolean> => {
	if (fs.existsSync(dirPath)) {
		return true;
	}
	return fs.promises.mkdir(dirPath, { recursive: true })
		.then(() => true)
		.catch((err: NodeJS.ErrnoException) => {
			console.error(`[ProjectHandler] Failed to create ${dirPath}: ${err.message}`);
			return false;
		});
};

const syncScript = async (
	extensionPath: string | undefined,
	sourceRelative: string,
	destDir: string,
	destFileName: string
): Promise<boolean | null> => {
	const destPath = path.join(destDir, destFileName);
	const sourcePath = findAssetSource(extensionPath, sourceRelative);
	if (sourcePath == null) {
		console.warn(`[ProjectHandler] ${sourceRelative} not found in extension assets.`);
		return false;
	}

	// If destination exists, compare contents -- skip if identical
	if (fs.existsSync(destPath)) {
		try {
			const [src, dst] = await Promise.all([
				fs.promises.readFile(sourcePath),
				fs.promises.readFile(destPath)
			]);
			if (src.equals(dst)) {
				return null; // Already up to date
			}
		} catch {
			// If comparison fails, overwrite to be safe
		}
	}

	return fs.promises.copyFile(sourcePath, destPath)
		.then(() => true)
		.catch((err: NodeJS.ErrnoException) => {
			console.error(`[ProjectHandler] Failed to copy ${sourceRelative}: ${err.message}`);
			return false;
		});
};

const findAssetSource = (extensionPath: string | undefined, relativePath: string): string | undefined => {
	const possiblePaths: string[] = extensionPath
		? [
			path.join(extensionPath, 'unity-assets', relativePath),
			path.join(extensionPath, 'out', 'unity-assets', relativePath)
		]
		: [
			path.join(__dirname, '..', '..', 'unity-assets', relativePath),
			path.join(__dirname, '..', '..', '..', 'unity-assets', relativePath)
		];

	for (const p of possiblePaths) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return undefined;
};
