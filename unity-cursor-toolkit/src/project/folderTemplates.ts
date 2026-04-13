/**
 * Folder Templates -- generate Unity folder structures from built-in or custom templates.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface FolderTemplate {
	name: string;
	description: string;
	folders: string[];
}

const BUILT_IN_TEMPLATES: FolderTemplate[] = [
	{
		name: 'Standard',
		description: 'Standard Unity project structure',
		folders: [
			'Assets/Scripts',
			'Assets/Scripts/Managers',
			'Assets/Scripts/UI',
			'Assets/Prefabs',
			'Assets/Materials',
			'Assets/Textures',
			'Assets/Audio/Music',
			'Assets/Audio/SFX',
			'Assets/Scenes',
			'Assets/Animations',
			'Assets/Editor',
			'Assets/Resources',
			'Assets/StreamingAssets',
			'Assets/Plugins'
		]
	},
	{
		name: 'FPS',
		description: 'First-person shooter project',
		folders: [
			'Assets/Scripts/Player',
			'Assets/Scripts/Weapons',
			'Assets/Scripts/AI',
			'Assets/Scripts/UI',
			'Assets/Scripts/Managers',
			'Assets/Scripts/Networking',
			'Assets/Prefabs/Characters',
			'Assets/Prefabs/Weapons',
			'Assets/Prefabs/Environment',
			'Assets/Prefabs/VFX',
			'Assets/Materials',
			'Assets/Textures',
			'Assets/Audio/Music',
			'Assets/Audio/SFX',
			'Assets/Audio/Ambience',
			'Assets/Scenes',
			'Assets/Animations',
			'Assets/Editor',
			'Assets/Resources'
		]
	},
	{
		name: 'Multiplayer',
		description: 'Multiplayer game project',
		folders: [
			'Assets/Scripts/Client',
			'Assets/Scripts/Server',
			'Assets/Scripts/Shared',
			'Assets/Scripts/Networking',
			'Assets/Scripts/UI',
			'Assets/Scripts/Managers',
			'Assets/Prefabs/Characters',
			'Assets/Prefabs/Environment',
			'Assets/Prefabs/UI',
			'Assets/Materials',
			'Assets/Textures',
			'Assets/Audio/Music',
			'Assets/Audio/SFX',
			'Assets/Scenes',
			'Assets/Animations',
			'Assets/Editor',
			'Assets/Resources',
			'Assets/ScriptableObjects'
		]
	},
	{
		name: 'VR',
		description: 'Virtual reality project',
		folders: [
			'Assets/Scripts/Player',
			'Assets/Scripts/Interaction',
			'Assets/Scripts/UI',
			'Assets/Scripts/Managers',
			'Assets/Prefabs/Interactables',
			'Assets/Prefabs/Environment',
			'Assets/Prefabs/UI',
			'Assets/Prefabs/Hands',
			'Assets/Materials',
			'Assets/Textures',
			'Assets/Audio/Music',
			'Assets/Audio/SFX',
			'Assets/Audio/Spatial',
			'Assets/Scenes',
			'Assets/Animations',
			'Assets/Editor',
			'Assets/Resources',
			'Assets/XR'
		]
	}
];

export const pickAndGenerateTemplate = async (): Promise<void> => {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders == null || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const rootPath = workspaceFolders[0].uri.fsPath;

	const items = BUILT_IN_TEMPLATES.map((t) => ({
		label: t.name,
		description: t.description,
		template: t
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a folder structure template'
	});

	if (selected == null) {
		return;
	}

	let created = 0;
	for (const folder of selected.template.folders) {
		const fullPath = path.join(rootPath, folder);
		if (fs.existsSync(fullPath) === false) {
			await fs.promises.mkdir(fullPath, { recursive: true });
			created++;
		}
	}

	vscode.window.showInformationMessage(
		`Generated ${selected.template.name} template: ${created} folders created.`
	);
};
