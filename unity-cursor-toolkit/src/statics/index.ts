import * as vscode from 'vscode';
import type { IModule, ModuleContext } from '../core/interfaces';
import { ConnectionState } from '../core/types';

/** Synchronizes opt-in snapshot settings; no transition hooks or report surfaces. */
export class StaticsModule implements IModule {
	public readonly id = 'statics';
	private context: ModuleContext | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		this.context = ctx;
		const synchronize = () => {
			if (!this.context || ctx.connectionManager.info.state !== ConnectionState.Connected) return;
			const config = vscode.workspace.getConfiguration('unityCursorToolkit.statics');
			ctx.commandSender.send('configureStatics', {
				enabled: config.get<unknown>('enabled', false),
				assemblyAllowlist: config.get<unknown>('assemblyAllowlist', []),
				maxFields: config.get<unknown>('maxFields', 1000),
				maxScanMilliseconds: config.get<unknown>('maxScanMilliseconds', 10)
			});
		};
		this.disposables.push(ctx.connectionManager.onStateChanged(synchronize),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('unityCursorToolkit.statics')) synchronize();
			}));
		synchronize();
	}

	public async deactivate(): Promise<void> {
		this.context?.commandSender.send('configureStatics', { enabled: false });
		this.context = undefined;
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables.length = 0;
	}
}
