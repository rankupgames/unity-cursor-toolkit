/**
 * Welcome Panel -- workspace-first project list with auto-create workspace.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export const openOrCreateWorkspace = async (): Promise<void> => {
	const folderUri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: 'Open Project Folder',
		title: 'Select Project Folder'
	});

	if (folderUri == null || folderUri.length === 0) {
		return;
	}

	const folderPath = folderUri[0].fsPath;
	const folderName = path.basename(folderPath);
	const workspacePath = path.join(folderPath, `${folderName}.code-workspace`);

	if (fs.existsSync(workspacePath) === false) {
		const workspaceContent = JSON.stringify(
			{ folders: [{ path: '.' }], settings: {} },
			null,
			2
		);
		await fs.promises.writeFile(workspacePath, workspaceContent, 'utf-8');
	}

	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath));
};
