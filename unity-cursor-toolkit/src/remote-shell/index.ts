import * as vscode from 'vscode';
import { spawn } from 'child_process';
import type { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { buildRemoteShellInvocation, RemoteShellExtensionSettings } from './extensionCommands';

export class RemoteShellModule implements IModule {
	public readonly id = 'remote-shell';

	private outputChannel: vscode.OutputChannel | undefined;

	public async activate(ctx: ModuleContext): Promise<void> {
		this.outputChannel = vscode.window.createOutputChannel('Unity VDD Shell');
		ctx.registerCommand('unity-cursor-toolkit.remoteShell.launch', () => this.run('launch', ctx));
		ctx.registerCommand('unity-cursor-toolkit.remoteShell.stop', () => this.run('stop', ctx));
		ctx.registerCommand('unity-cursor-toolkit.remoteShell.status', () => this.run('status', ctx));
		ctx.registerStatusBarContributor(new RemoteShellStatusBarContributor());
	}

	public async deactivate(): Promise<void> {
		this.outputChannel?.dispose();
		this.outputChannel = undefined;
	}

	private async run(action: 'launch' | 'stop' | 'status', ctx: ModuleContext): Promise<void> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (workspaceRoot == null) {
			vscode.window.showErrorMessage('Open a workspace before launching the Unity VDD shell.');
			return;
		}

		const settings = this.getSettings();
		const invocation = buildRemoteShellInvocation(action, ctx.extensionContext.extensionPath, workspaceRoot, settings);
		this.outputChannel?.appendLine(`> ${invocation.command} ${invocation.args.map(quoteArg).join(' ')}`);

		await new Promise<void>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: workspaceRoot,
				env: process.env
			});

			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stdout += text;
				this.outputChannel?.append(text);
			});
			child.stderr.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stderr += text;
				this.outputChannel?.append(text);
			});
			child.on('error', (error) => {
				this.outputChannel?.appendLine(error.message);
				vscode.window.showErrorMessage(`Unity VDD shell ${action} failed: ${error.message}`);
				resolve();
			});
			child.on('exit', (code) => {
				if (code === 0) {
					this.showSuccess(action, stdout);
				} else {
					const message = stderr.trim() || stdout.trim() || `exit code ${code}`;
					vscode.window.showErrorMessage(`Unity VDD shell ${action} failed: ${message}`);
				}
				resolve();
			});
		});
	}

	private showSuccess(action: 'launch' | 'stop' | 'status', stdout: string): void {
		const text = stdout.trim();
		if (text.length === 0) {
			vscode.window.showInformationMessage(`Unity VDD shell ${action} completed.`);
			return;
		}

		if (action === 'launch') {
			const streamUrl = extractJsonString(text, 'streamUrl');
			const statusUrl = extractJsonString(text, 'statusUrl');
			const suffix = streamUrl ? ` Stream: ${streamUrl}${statusUrl ? ` Status: ${statusUrl}` : ''}` : '';
			vscode.window.showInformationMessage(`Unity VDD shell launch requested.${suffix}`);
			return;
		}

		vscode.window.showInformationMessage(`Unity VDD shell ${action} completed.`);
	}

	private getWorkspaceRoot(): string | undefined {
		const folders = vscode.workspace.workspaceFolders;
		return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	private getSettings(): RemoteShellExtensionSettings {
		const config = vscode.workspace.getConfiguration('unityCursorToolkit.remoteShell');
		return {
			manifestPath: config.get<string>('manifestPath'),
			shellAppPath: config.get<string>('shellAppPath'),
			localPortBase: config.get<number>('localPortBase')
		};
	}
}

class RemoteShellStatusBarContributor implements IStatusBarContributor {
	public readonly group = 'Remote Shell';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(window) Launch Unity VDD Shell', command: 'unity-cursor-toolkit.remoteShell.launch' },
			{ label: '$(pulse) Unity VDD Shell Status', command: 'unity-cursor-toolkit.remoteShell.status' },
			{ label: '$(debug-stop) Stop Unity VDD Shell', command: 'unity-cursor-toolkit.remoteShell.stop' }
		];
	}
}

function extractJsonString(text: string, key: string): string | undefined {
	try {
		const parsed = JSON.parse(text) as { links?: Record<string, unknown> };
		const value = parsed.links?.[key];
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

function quoteArg(arg: string): string {
	return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
