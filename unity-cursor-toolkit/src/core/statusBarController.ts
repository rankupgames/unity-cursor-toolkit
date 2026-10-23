/**
 * Status Bar Controller -- bridge, quick access and CLI diagnostics:
 * left = one-click connect toggle, right = quick-access dropdown.
 * Collects IStatusBarContributor registrations from modules.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IStatusBarContributor } from './interfaces';
import { ConnectionState } from './types';
import { type UnityCliResult, UNITY_CLI_EXPECTED_VERSION } from './unityCliAdapter';
import { getHotReloadMode, type RuntimeCapabilities } from './runtimeCapabilities';

export class StatusBarController implements vscode.Disposable {

	private readonly connectItem: vscode.StatusBarItem;
	private readonly quickAccessItem: vscode.StatusBarItem;
	private readonly cliItem: vscode.StatusBarItem;
	private readonly contributors: IStatusBarContributor[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private projectName = '';

	constructor(context: vscode.ExtensionContext, private readonly getRuntimeCapabilities?: () => RuntimeCapabilities) {
		this.connectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
		this.connectItem.command = 'unity-cursor-toolkit.startConnection';

		this.quickAccessItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
		this.quickAccessItem.command = 'unity-cursor-toolkit.quickAccess';
		this.quickAccessItem.text = '$(triangle-down)';
		this.quickAccessItem.tooltip = 'Unity Quick Actions';

		this.cliItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.cliItem.command = 'unity-cursor-toolkit.doctor';
		context.subscriptions.push(this.connectItem, this.quickAccessItem, this.cliItem);

		this.disposables.push(
			vscode.commands.registerCommand('unity-cursor-toolkit.quickAccess', () => this.showQuickAccess())
		);

		this.update(ConnectionState.Disconnected, null);
	}

	public addContributor(contributor: IStatusBarContributor): void {
		this.contributors.push(contributor);
	}

	public setUnityCliStatus(result: UnityCliResult<{ version: string; expectedVersion: string }>): void {
		const rawVersion = result.ok ? result.data.version : result.error.foundVersion;
		const version = typeof rawVersion === 'string' && rawVersion.length <= 64
			&& /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|preview)\.\d+)?$/.test(rawVersion) ? rawVersion : 'unverified version';
		this.cliItem.text = result.ok ? 'CLI ' + version
			: result.error.code === 'cli_not_found' ? '$(warning) CLI not found'
			: result.error.code === 'version_mismatch' ? '$(warning) CLI ' + version : '$(warning) CLI unavailable';
		this.cliItem.tooltip = (result.ok ? 'Unity CLI ' + version + ' matches the pinned version.'
			: result.error.code === 'version_mismatch' ? 'version_mismatch: Expected Unity CLI ' + UNITY_CLI_EXPECTED_VERSION + '; found ' + version + '.'
			: result.error.code + ': Run Unity CLI Doctor to check the installation.')
			+ (result.binaryPath ? '\nBinary: ' + result.binaryPath : '') + '\nClick to run Unity CLI Doctor.';
		this.cliItem.color = result.ok ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
		this.cliItem.show();
	}

	public setProjectName(name: string): void {
		this.projectName = name;
	}

	public update(state: ConnectionState, port: number | null): void {
		const name = this.projectName;
		const mode = this.getReloadLabel();

		switch (state) {
			case ConnectionState.Connected:
				this.connectItem.text = `$(circle-filled) Unity${name ? ` (${name})` : ''}${mode ? ' | ' + mode : ''}`;
				this.connectItem.tooltip = `Connected on port ${port}. Click to disconnect.`
					+ (mode ? '\nReload mode: ' + mode + '.' : '')
					+ (mode === 'Mono reload' ? ' The Editor selects asset refresh or IL patching from Play Mode and its preferences.'
						: mode === 'Unity reload' ? ' CoreCLR uses Unity compilation; IL patching is unavailable.' : '');
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
		const mode = this.getReloadLabel();
		if (success) {
			const suffix = warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : '';
			this.connectItem.text = `$(check) Unity${suffix}${mode ? ' | ' + mode : ''}`;
			this.connectItem.color = new vscode.ThemeColor('charts.green');
		} else {
			this.connectItem.text = `$(error) Unity (${errors} error${errors > 1 ? 's' : ''})${mode ? ' | ' + mode : ''}`;
			this.connectItem.color = new vscode.ThemeColor('errorForeground');
		}
	}

	private getReloadLabel(): string {
		if (!this.getRuntimeCapabilities) return '';
		try {
			return getHotReloadMode(this.getRuntimeCapabilities()) === 'il-patch' ? 'Mono reload' : 'Unity reload';
		} catch { return 'Reload unavailable'; }
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
