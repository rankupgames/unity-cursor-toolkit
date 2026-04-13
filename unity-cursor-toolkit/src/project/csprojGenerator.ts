/**
 * csproj Generator -- stub for IntelliSense csproj generation.
 * Full implementation studies com.boxqkrtm.ide.cursor and com.tsk.ide.vscode approaches.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export const hasCsprojFiles = (projectPath: string): boolean => {
	try {
		const files = fs.readdirSync(projectPath);
		return files.some((f) => f.endsWith('.csproj'));
	} catch {
		return false;
	}
};

export const promptCsprojGeneration = async (projectPath: string): Promise<void> => {
	if (hasCsprojFiles(projectPath)) {
		return;
	}

	const result = await vscode.window.showInformationMessage(
		'No .csproj files found. For C# IntelliSense, open the Unity project in Unity Editor and regenerate project files via Edit > Preferences > External Tools > Regenerate project files.',
		'OK'
	);
};
