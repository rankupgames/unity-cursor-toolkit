/**
 * Meta Manager -- auto-exclude .meta files from explorer/Cmd+P,
 * on-demand resolve for AI, auto-rename/delete tracking.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class MetaManager implements vscode.Disposable {

	private fileWatcher: vscode.FileSystemWatcher | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{cs,asset,prefab,mat,shader,png,jpg,fbx,anim,controller}');
		this.fileWatcher.onDidDelete((uri) => this.handleAssetDeleted(uri));

		this.disposables.push(this.fileWatcher);
	}

	public static async applyMetaExclusions(projectPath: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('files', vscode.Uri.file(projectPath));
		const existing = config.get<Record<string, boolean>>('exclude') ?? {};

		if (existing['**/*.meta'] !== true) {
			await config.update('exclude', { ...existing, '**/*.meta': true }, vscode.ConfigurationTarget.Workspace);
		}

		const ignoreFile = path.join(projectPath, '.cursorindexingignore');
		if (fs.existsSync(ignoreFile) === false) {
			await fs.promises.writeFile(ignoreFile, '*.meta\n', 'utf-8');
		}
	}

	public async resolveMetaInteractive(): Promise<void> {
		const input = await vscode.window.showInputBox({
			prompt: 'Asset path (e.g. Assets/Scripts/Player.cs)',
			placeHolder: 'Assets/Scripts/Player.cs'
		});

		if (input == null || input.trim().length === 0) {
			return;
		}

		const result = await this.resolveMetaFile(input.trim());
		if (result) {
			const doc = await vscode.workspace.openTextDocument({ content: result, language: 'yaml' });
			await vscode.window.showTextDocument(doc, { preview: true });
		}
	}

	public async resolveMetaFile(assetPath: string): Promise<string | null> {
		const requestedAssetPath = assetPath.trim();
		if (requestedAssetPath.length === 0) {
			return null;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders == null) {
			return null;
		}

		for (const folder of workspaceFolders) {
			const workspacePath = path.resolve(folder.uri.fsPath);
			const metaPath = path.resolve(workspacePath, requestedAssetPath + '.meta');
			if (MetaManager.isPathInsideWorkspace(workspacePath, metaPath) === false) {
				continue;
			}

			if (fs.existsSync(metaPath)) {
				return fs.promises.readFile(metaPath, 'utf-8');
			}
		}

		vscode.window.showWarningMessage(`Meta file not found for: ${requestedAssetPath}`);
		return null;
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private handleAssetDeleted(uri: vscode.Uri): void {
		const metaPath = uri.fsPath + '.meta';
		if (fs.existsSync(metaPath)) {
			fs.promises.unlink(metaPath).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[MetaManager] Failed to delete meta file: ${message}`);
			});
		}
	}

	private static isPathInsideWorkspace(workspacePath: string, targetPath: string): boolean {
		const relativePath = path.relative(workspacePath, targetPath);
		return relativePath.length === 0
			|| (relativePath !== '..' && relativePath.startsWith(`..${path.sep}`) === false && path.isAbsolute(relativePath) === false);
	}
}
