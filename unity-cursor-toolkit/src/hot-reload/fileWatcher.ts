/**
 * File Watcher -- watches Unity C# file changes with debounced refresh
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IConnectionManager } from '../core/interfaces';

const DEBOUNCE_MS = 300;
const MAX_PENDING_FILES = 1_000;
const GENERATED_FOLDERS = new Set(['library', 'temp', 'obj', '.git']);

export class FileWatcher implements vscode.Disposable {

	private csWatcher: vscode.FileSystemWatcher | undefined;
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

		this.csWatcher = vscode.workspace.createFileSystemWatcher('**/{Assets,Packages}/**/*.cs');
		this.csWatcher.onDidChange((uri) => this.scheduleRefresh(uri.fsPath));
	}

	public disable(): void {
		this.enabled = false;
		this.clearDebounce();
		this.pendingFiles.clear();

		if (this.csWatcher) {
			this.csWatcher.dispose();
			this.csWatcher = undefined;
		}
	}

	public dispose(): void {
		this.disable();
	}

	private scheduleRefresh(filePath?: string): void {
		if (filePath && this.isRefreshableScript(filePath) && this.pendingFiles.size < MAX_PENDING_FILES) {
			this.pendingFiles.add(filePath);
		}
		if (this.pendingFiles.size === 0) {
			return;
		}

		this.clearDebounce();
		this.debounceTimer = setTimeout(() => {
			const files = Array.from(this.pendingFiles);
			this.pendingFiles.clear();
			this.connection.send('refresh', { timestamp: Date.now(), files });
		}, DEBOUNCE_MS);
	}

	private isRefreshableScript(filePath: string): boolean {
		const segments = filePath.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0);
		if (segments.some((segment) => GENERATED_FOLDERS.has(segment.toLowerCase()))) {
			return false;
		}

		return filePath.toLowerCase().endsWith('.cs')
			&& segments.some((segment) => segment === 'Assets' || segment === 'Packages');
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
	}
}
