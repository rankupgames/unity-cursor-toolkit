/**
 * Hot Reload Module -- file watching, refresh commands, IL patch feedback.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ConnectionState } from '../core/types';
import { FileWatcher } from './fileWatcher';

export class HotReloadModule implements IModule {

	public readonly id = 'hot-reload';

	private fileWatcher: FileWatcher | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		this.fileWatcher = new FileWatcher(ctx.connectionManager);

		this.disposables.push(this.fileWatcher);

		ctx.connectionManager.onStateChanged((info) => {
			if (info.state === ConnectionState.Connected) {
				this.fileWatcher?.enable();
			} else if (info.state === ConnectionState.Disconnected) {
				this.fileWatcher?.disable();
			}
		});

		ctx.registerStatusBarContributor(new HotReloadStatusContributor());
	}

	public async deactivate(): Promise<void> {
		this.fileWatcher?.disable();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

class HotReloadStatusContributor implements IStatusBarContributor {

	public readonly group = 'Project';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(refresh) Refresh Assets', command: 'unity-cursor-toolkit.reloadConnection' }
		];
	}
}
