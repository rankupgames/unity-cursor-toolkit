/**
 * File Watcher -- watches Unity C# file changes with debounced refresh
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IConnectionManager } from '../core/interfaces';

const DEBOUNCE_MS = 300;

export class FileWatcher implements vscode.Disposable {

	private csWatcher: vscode.FileSystemWatcher | undefined;
	private solutionWatcher: vscode.FileSystemWatcher | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly connection: IConnectionManager;
	private enabled = false;
	private pendingFiles: Set<string> = new Set();

	constructor(connection: IConnectionManager) {
		this.connection = connection;
	}

	public enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;

		this.csWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
		this.csWatcher.onDidChange((uri) => this.scheduleRefresh(uri.fsPath));

		this.solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,csproj}');
		this.solutionWatcher.onDidChange(() => this.scheduleRefresh());
	}

	public disable(): void {
		this.enabled = false;
		this.clearDebounce();

		if (this.csWatcher) {
			this.csWatcher.dispose();
			this.csWatcher = undefined;
		}
		if (this.solutionWatcher) {
			this.solutionWatcher.dispose();
			this.solutionWatcher = undefined;
		}
	}

	public dispose(): void {
		this.disable();
	}

	private scheduleRefresh(filePath?: string): void {
		if (filePath) {
			this.pendingFiles.add(filePath);
		}

		this.clearDebounce();
		this.debounceTimer = setTimeout(() => {
			const files = Array.from(this.pendingFiles);
			this.pendingFiles.clear();
			this.connection.send('refresh', { timestamp: Date.now(), files });
		}, DEBOUNCE_MS);
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
	}
}
