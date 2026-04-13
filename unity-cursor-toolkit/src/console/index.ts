/**
 * Console Module -- standalone module for Unity console streaming,
 * search, clickable traces, copy, send-to-chat, and MCP tools.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ConsoleBridge } from './consoleBridge';
import { ConsolePanelProvider } from './consolePanel';
import { ConsoleMcpTools } from './consoleMcpTools';

export class ConsoleModule implements IModule {

	public readonly id = 'console';

	private bridge: ConsoleBridge | undefined;
	private provider: ConsolePanelProvider | undefined;
	private outputChannel: vscode.OutputChannel | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		this.bridge = new ConsoleBridge(ctx.connectionManager);
		this.provider = new ConsolePanelProvider(ctx.extensionContext.extensionUri, this.bridge);
		this.outputChannel = vscode.window.createOutputChannel('Unity Console');

		this.disposables.push(
			this.bridge,
			this.provider,
			this.outputChannel,
			vscode.window.registerWebviewViewProvider(ConsolePanelProvider.viewId, this.provider),
			this.bridge.onEntry((entry) => {
				const prefix = `[${entry.type.toUpperCase()}]`;
				this.outputChannel?.appendLine(`${prefix} [${entry.timestamp}] ${entry.message}`);
				if (entry.stackTrace) {
					this.outputChannel?.appendLine(entry.stackTrace);
				}
			}),
			this.bridge.onClear(() => {
				this.outputChannel?.clear();
			})
		);

		ctx.registerCommand('unity-cursor-toolkit.console.clear', () => {
			this.provider?.clear();
			this.outputChannel?.clear();
		});

		ctx.registerCommand('unity-cursor-toolkit.console.sendToChat', () => {
			if (this.bridge == null) {
				return;
			}
			const entries = this.bridge.getEntries();
			const lines = entries.map((e) => {
				const prefix = `[${e.type.toUpperCase()}]`;
				let line = `${prefix} [${e.timestamp}] ${e.message}`;
				if (e.stackTrace) {
					line += '\n' + e.stackTrace;
				}
				return line;
			});
			const content = 'Unity Console Output:\n---\n' + lines.join('\n\n');
			this.bridge.sendToChat(content, entries.length);
		});

		ctx.registerCommand('unity-cursor-toolkit.console.copy', () => {
			this.provider?.copyToClipboard();
		});

		ctx.registerCommand('unity-cursor-toolkit.console.snapshot', () => {
			this.provider?.snapshot();
		});

		ctx.registerCommand('unity-cursor-toolkit.console.export', () => {
			this.provider?.exportLogs();
		});

		ctx.registerToolProvider(new ConsoleMcpTools(this.bridge!));
		ctx.registerStatusBarContributor(new ConsoleStatusBarContributor());
	}

	public async deactivate(): Promise<void> {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

class ConsoleStatusBarContributor implements IStatusBarContributor {

	public readonly group = 'Console';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(copy) Console Snapshot', command: 'unity-cursor-toolkit.console.snapshot' },
			{ label: '$(comment-discussion) Send to AI Chat', command: 'unity-cursor-toolkit.console.sendToChat' },
			{ label: '$(clear-all) Clear Console', command: 'unity-cursor-toolkit.console.clear' },
			{ label: '$(save) Export Logs', command: 'unity-cursor-toolkit.console.export' }
		];
	}
}
