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
import { getHotReloadMode } from '../core/runtimeCapabilities';

export class HotReloadModule implements IModule {

	public readonly id = 'hot-reload';

	private fileWatcher: FileWatcher | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		this.fileWatcher = new FileWatcher(ctx.connectionManager);

		this.disposables.push(this.fileWatcher);

		const updateWatcher = () => {
			this.fileWatcher?.disable();
			if (ctx.connectionManager.info.state !== ConnectionState.Connected) return;
			try {
				// CoreCLR leaves code reload to Unity's compilation workflow. Do not send IL refresh requests.
				if (getHotReloadMode(ctx.connectionManager.getRuntimeCapabilities()) === 'il-patch') {
					this.fileWatcher?.enable();
				}
			} catch { /* Pending or invalid handshake keeps runtime features disabled. */ }
		};
		this.disposables.push(
			ctx.connectionManager.onStateChanged(updateWatcher),
			ctx.connectionManager.onRuntimeCapabilitiesChanged(updateWatcher),
			ctx.connectionManager.onMessage(msg => {
				if (msg.command === 'compilationResult' && msg.payload.errorCode === 'capability_unavailable') {
					vscode.window.showWarningMessage(`capability_unavailable: ${String(msg.payload.error ?? 'IL patching is unavailable.')}`);
				}
			})
		);
		updateWatcher();

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
