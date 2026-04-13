/**
 * Unity Project Handler -- Manages Unity project detection, selection, and linking
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MetaManager } from './metaManager';

const CURRENT_PROJECT_KEY = 'unityCursorToolkit.currentProjectUri';
const UNITY_SCRIPTS = ['HotReloadHandler.cs', 'ConsoleToCursor.cs', 'DebugBridge.cs'];

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

	return fs.existsSync(path.join(projectPath, 'Assets', 'Editor', 'HotReloadHandler.cs'));
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
	const editorPath = path.join(targetFolder.fsPath, 'Assets', 'Editor');

	if (fs.existsSync(editorPath) === false) {
		const created = await fs.promises.mkdir(editorPath, { recursive: true })
			.then(() => true)
			.catch((err: NodeJS.ErrnoException) => {
				vscode.window.showErrorMessage(`Failed to create Editor folder: ${err.message}`);
				return false;
			});

		if (created === false) {
			return false;
		}
	}

	let anyInstalled = false;
	let allSkipped = true;

	for (const scriptName of UNITY_SCRIPTS) {
		const destPath = path.join(editorPath, scriptName);
		if (fs.existsSync(destPath)) {
			continue;
		}

		allSkipped = false;
		const sourcePath = findAssetSource(extensionPath, scriptName);
		if (sourcePath == null) {
			console.warn(`[ProjectHandler] ${scriptName} not found in extension assets.`);
			continue;
		}

		const copied = await fs.promises.copyFile(sourcePath, destPath)
			.then(() => true)
			.catch((err: NodeJS.ErrnoException) => {
				console.error(`[ProjectHandler] Failed to copy ${scriptName}: ${err.message}`);
				return false;
			});

		if (copied) {
			anyInstalled = true;
		}
	}

	if (allSkipped) {
		vscode.window.showInformationMessage('Unity Toolkit scripts already present.');
		return true;
	}

	if (anyInstalled) {
		vscode.window.showInformationMessage('Installed Unity Toolkit scripts. Restart Unity if running.');
	}

	await MetaManager.applyMetaExclusions(targetFolder.fsPath);
	return true;
};

const ASSET_SUBFOLDERS: Record<string, string> = { 'DebugBridge.cs': 'Debug' };

const findAssetSource = (extensionPath: string | undefined, fileName: string): string | undefined => {
	const subfolder = ASSET_SUBFOLDERS[fileName];
	const basePaths = extensionPath
		? [
			path.join(extensionPath, 'unity-assets'),
			path.join(extensionPath, 'out', 'unity-assets')
		]
		: [
			path.join(__dirname, '..', '..', 'unity-assets'),
			path.join(__dirname, '..', '..', '..', 'unity-assets')
		];

	const possiblePaths = basePaths.flatMap((base) =>
		subfolder
			? [path.join(base, fileName), path.join(base, subfolder, fileName)]
			: [path.join(base, fileName)]
	);

	for (const p of possiblePaths) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return undefined;
};
