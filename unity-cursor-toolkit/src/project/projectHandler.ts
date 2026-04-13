/**
 * Unity Project Handler -- Manages Unity project detection, selection, linking,
 * and UPM package injection into the project's manifest.json.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MetaManager } from './metaManager';

const CURRENT_PROJECT_KEY = 'unityCursorToolkit.currentProjectUri';
const PACKAGE_NAME = 'com.rankupgames.unity-cursor-toolkit';
const PACKAGE_VERSION = '1.0.0';
const MIN_UPM_VERSION = '1.0.0';
const OPENUPM_REGISTRY_URL = 'https://package.openupm.com';
const OPENUPM_SCOPE = 'com.rankupgames';

const LEGACY_SCRIPTS = ['HotReloadHandler.cs', 'ConsoleToCursor.cs', 'DebugBridge.cs'];

interface ScopedRegistry {
	name: string;
	url: string;
	scopes: string[];
}

interface UnityManifest {
	scopedRegistries?: ScopedRegistry[];
	dependencies?: Record<string, string>;
}

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

export const isScriptInstalledInLinkedProject = (): boolean => {
	const projectPath = getLinkedProjectPath();
	if (projectPath == null) {
		return false;
	}

	return isUpmPackageInstalled(projectPath);
};

export const isUpmPackageInstalled = (projectPath: string): boolean => {
	const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
	if (fs.existsSync(manifestPath) === false) {
		return false;
	}

	try {
		const manifest = fs.readFileSync(manifestPath, 'utf8');
		return manifest.includes(PACKAGE_NAME);
	} catch (error: unknown) {
		console.warn(`[ProjectHandler] Failed to read manifest.json: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
};

export const getInstalledUpmVersion = (projectPath: string): string | null => {
	const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
	if (fs.existsSync(manifestPath) === false) {
		return null;
	}

	try {
		const manifest: UnityManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		return manifest.dependencies?.[PACKAGE_NAME] ?? null;
	} catch (error: unknown) {
		console.warn(`[ProjectHandler] Failed to parse manifest.json: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
};

const compareVersions = (installed: string, required: string): number => {
	const parseVersion = (version: string): number[] => version.split('.').map((segment) => parseInt(segment, 10) || 0);
	const installedParts = parseVersion(installed);
	const requiredParts = parseVersion(required);
	const maxLength = Math.max(installedParts.length, requiredParts.length);

	for (let i = 0; i < maxLength; i++) {
		const installedSegment = installedParts[i] ?? 0;
		const requiredSegment = requiredParts[i] ?? 0;
		if (installedSegment < requiredSegment) return -1;
		if (installedSegment > requiredSegment) return 1;
	}
	return 0;
};

export const injectUpmPackage = (projectPath: string): boolean => {
	const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');
	if (fs.existsSync(manifestPath) === false) {
		return false;
	}

	let manifest: UnityManifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (error: unknown) {
		console.error(`[ProjectHandler] Failed to parse manifest.json: ${error instanceof Error ? error.message : String(error)}`);
		vscode.window.showErrorMessage('Failed to read Packages/manifest.json. The file may be corrupted.');
		return false;
	}

	if (manifest.dependencies?.[PACKAGE_NAME]) {
		return true;
	}

	if (Array.isArray(manifest.scopedRegistries) === false) {
		manifest.scopedRegistries = [];
	}

	const registries = manifest.scopedRegistries as ScopedRegistry[];
	const existingRegistry = registries.find((registry) => registry.url === OPENUPM_REGISTRY_URL);
	if (existingRegistry) {
		if (existingRegistry.scopes.includes(OPENUPM_SCOPE) === false) {
			existingRegistry.scopes.push(OPENUPM_SCOPE);
		}
	} else {
		registries.push({
			name: 'OpenUPM',
			url: OPENUPM_REGISTRY_URL,
			scopes: [OPENUPM_SCOPE]
		});
	}

	manifest.dependencies = manifest.dependencies ?? {};
	manifest.dependencies[PACKAGE_NAME] = PACKAGE_VERSION;

	try {
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
		return true;
	} catch (error: unknown) {
		console.error(`[ProjectHandler] Failed to write manifest.json: ${error instanceof Error ? error.message : String(error)}`);
		vscode.window.showErrorMessage('Failed to update Packages/manifest.json.');
		return false;
	}
};

const updateUpmVersion = (projectPath: string, newVersion: string): boolean => {
	const manifestPath = path.join(projectPath, 'Packages', 'manifest.json');

	try {
		const manifest: UnityManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		if (manifest.dependencies == null) {
			return false;
		}
		manifest.dependencies[PACKAGE_NAME] = newVersion;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
		return true;
	} catch (error: unknown) {
		console.error(`[ProjectHandler] Failed to update UPM version: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
};

export const checkAndUpdateUpmVersion = async (projectPath: string): Promise<void> => {
	const installed = getInstalledUpmVersion(projectPath);
	if (installed == null) {
		return;
	}

	if (compareVersions(installed, MIN_UPM_VERSION) < 0) {
		const result = await vscode.window.showInformationMessage(
			`Unity Cursor Toolkit package is outdated (${installed} < ${MIN_UPM_VERSION}). Update to ${MIN_UPM_VERSION}?`,
			'Update',
			'Skip'
		);
		if (result === 'Update') {
			if (updateUpmVersion(projectPath, MIN_UPM_VERSION)) {
				vscode.window.showInformationMessage(`Updated Unity Cursor Toolkit to ${MIN_UPM_VERSION}. Switch to Unity to apply.`);
			}
		}
	}
};

export const detectLegacyScripts = (projectPath: string): string[] => {
	const editorPath = path.join(projectPath, 'Assets', 'Editor');
	if (fs.existsSync(editorPath) === false) {
		return [];
	}

	return LEGACY_SCRIPTS.filter((script) => fs.existsSync(path.join(editorPath, script)));
};

export const warnLegacyScripts = async (projectPath: string): Promise<void> => {
	const legacyFiles = detectLegacyScripts(projectPath);
	if (legacyFiles.length === 0) {
		return;
	}

	const fileList = legacyFiles.join(', ');
	await vscode.window.showWarningMessage(
		`Legacy scripts found in Assets/Editor: ${fileList}. Remove them to avoid duplicate class errors with the UPM package.`,
		'OK'
	);
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
			return await setupUpmForProject(savedProjectUri);
		}
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders == null || workspaceFolders.length === 0) {
		const projectUri = await selectAndSetupExternalProject();
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
		const projectUri = await selectAndSetupExternalProject();
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
			const projectUri = await selectAndSetupExternalProject();
			return projectUri != null;
		}
		targetFolder = selected.uri;
	}

	if (targetFolder) {
		saveCurrentProjectUri(targetFolder);
		return await setupUpmForProject(targetFolder);
	}

	return false;
};

const setupUpmForProject = async (targetFolder: vscode.Uri): Promise<boolean> => {
	const projectPath = targetFolder.fsPath;

	if (isUpmPackageInstalled(projectPath)) {
		await checkAndUpdateUpmVersion(projectPath);
		await warnLegacyScripts(projectPath);
		await MetaManager.applyMetaExclusions(projectPath);
		return true;
	}

	const injected = injectUpmPackage(projectPath);
	if (injected === false) {
		const manualInstructions = `openupm add ${PACKAGE_NAME}`;
		const result = await vscode.window.showErrorMessage(
			'Failed to inject UPM package into manifest.json. Install manually:',
			'Copy Command'
		);
		if (result === 'Copy Command') {
			await vscode.env.clipboard.writeText(manualInstructions);
			vscode.window.showInformationMessage('Install command copied to clipboard.');
		}
		return false;
	}

	vscode.window.showInformationMessage(
		'Unity Cursor Toolkit package added to your project. Switch to Unity -- it will auto-import on focus.'
	);

	await warnLegacyScripts(projectPath);
	await MetaManager.applyMetaExclusions(projectPath);
	return true;
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

const selectAndSetupExternalProject = async (): Promise<vscode.Uri | undefined> => {
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
			`The selected folder doesn't appear to be a Unity project (no Assets folder). Continue anyway?`,
			'Continue',
			'Cancel'
		);
		if (result !== 'Continue') {
			return undefined;
		}
	}

	saveCurrentProjectUri(selectedFolder);
	const success = await setupUpmForProject(selectedFolder);
	return success ? selectedFolder : undefined;
};
