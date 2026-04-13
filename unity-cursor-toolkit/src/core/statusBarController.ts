/**
 * Status Bar Controller -- two-part status bar layout:
 * left = one-click connect toggle, right = quick-access dropdown.
 * Collects IStatusBarContributor registrations from modules.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IStatusBarContributor, QuickAccessAction } from './interfaces';
import { ConnectionState, ConnectionInfo } from './types';

export class StatusBarController implements vscode.Disposable {

	private readonly connectItem: vscode.StatusBarItem;
	private readonly quickAccessItem: vscode.StatusBarItem;
	private readonly contributors: IStatusBarContributor[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private projectName = '';

	constructor(context: vscode.ExtensionContext) {
		this.connectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
		this.connectItem.command = 'unity-cursor-toolkit.startConnection';

		this.quickAccessItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
		this.quickAccessItem.command = 'unity-cursor-toolkit.quickAccess';
		this.quickAccessItem.text = '$(triangle-down)';
		this.quickAccessItem.tooltip = 'Unity Quick Actions';

		context.subscriptions.push(this.connectItem, this.quickAccessItem);

		this.disposables.push(
			vscode.commands.registerCommand('unity-cursor-toolkit.quickAccess', () => this.showQuickAccess())
		);

		this.update(ConnectionState.Disconnected, null);
	}

	public addContributor(contributor: IStatusBarContributor): void {
		this.contributors.push(contributor);
	}

	public setProjectName(name: string): void {
		this.projectName = name;
	}

	public update(state: ConnectionState, port: number | null): void {
		const name = this.projectName;

		switch (state) {
			case ConnectionState.Connected:
				this.connectItem.text = `$(circle-filled) Unity${name ? ` (${name})` : ''}`;
				this.connectItem.tooltip = `Connected on port ${port}. Click to disconnect.`;
				this.connectItem.color = new vscode.ThemeColor('charts.green');
				this.connectItem.backgroundColor = undefined;
				this.connectItem.command = 'unity-cursor-toolkit.stopConnection';
				this.quickAccessItem.show();
				break;

			case ConnectionState.Connecting:
			case ConnectionState.Reconnecting:
				this.connectItem.text = `$(sync~spin) Unity${name ? ` (${name})` : ' (connecting)'}`;
				this.connectItem.tooltip = state === ConnectionState.Reconnecting ? 'Reconnecting...' : 'Connecting...';
				this.connectItem.color = undefined;
				this.connectItem.backgroundColor = undefined;
				this.connectItem.command = 'unity-cursor-toolkit.stopConnection';
				this.quickAccessItem.hide();
				break;

			case ConnectionState.Disconnected:
			default:
				if (name) {
					this.connectItem.text = `$(debug-disconnect) Unity (${name})`;
					this.connectItem.tooltip = 'Disconnected. Click to reconnect.';
					this.connectItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				} else {
					this.connectItem.text = '$(plug) Unity Attach';
					this.connectItem.tooltip = 'No project attached. Click to start.';
					this.connectItem.backgroundColor = undefined;
				}
				this.connectItem.color = undefined;
				this.connectItem.command = 'unity-cursor-toolkit.startConnection';
				this.quickAccessItem.hide();
				break;
		}

		this.connectItem.show();
	}

	public showCompilationResult(success: boolean, errors: number, warnings: number): void {
		if (success) {
			const suffix = warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : '';
			this.connectItem.text = `$(check) Unity${suffix}`;
			this.connectItem.color = new vscode.ThemeColor('charts.green');
		} else {
			this.connectItem.text = `$(error) Unity (${errors} error${errors > 1 ? 's' : ''})`;
			this.connectItem.color = new vscode.ThemeColor('errorForeground');
		}
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async showQuickAccess(): Promise<void> {
		const items: vscode.QuickPickItem[] = [];

		for (const contributor of this.contributors) {
			if (items.length > 0) {
				items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
			}

			items.push({ label: contributor.group, kind: vscode.QuickPickItemKind.Separator });

			for (const action of contributor.getActions()) {
				items.push({
					label: action.label,
					description: action.description,
					detail: action.command
				});
			}
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Unity Quick Actions'
		});

		if (selected?.detail) {
			await vscode.commands.executeCommand(selected.detail);
		}
	}
}
