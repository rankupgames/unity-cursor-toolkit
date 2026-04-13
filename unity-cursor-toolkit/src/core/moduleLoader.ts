/**
 * Module Loader -- discovers and activates IModule implementations,
 * respects feature flags, handles lifecycle.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IModule, ModuleContext } from './interfaces';

export class ModuleLoader implements vscode.Disposable {

	private readonly modules: IModule[] = [];
	private readonly activeModules: IModule[] = [];

	public register(mod: IModule): void {
		this.modules.push(mod);
	}

	public async activateAll(ctx: ModuleContext): Promise<void> {
		for (const mod of this.modules) {
			const enabled = vscode.workspace
				.getConfiguration('unityCursorToolkit.modules')
				.get<boolean>(`${mod.id}.enabled`, true);

			if (enabled === false) {
				continue;
			}

			try {
				await mod.activate(ctx);
				this.activeModules.push(mod);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[ModuleLoader] Failed to activate module '${mod.id}': ${message}`);
			}
		}
	}

	public async deactivateAll(): Promise<void> {
		for (const mod of this.activeModules.reverse()) {
			try {
				await mod.deactivate();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[ModuleLoader] Failed to deactivate module '${mod.id}': ${message}`);
			}
		}
		this.activeModules.length = 0;
	}

	public dispose(): void {
		// deactivateAll should be called from extension.deactivate() before dispose
	}
}
