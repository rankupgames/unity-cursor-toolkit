import * as vscode from 'vscode';
import type { ModuleContext } from '../core/interfaces';
import { UnityTestMcpTools } from './unityTestTools';

/** Command-palette surface over the same tools exposed to MCP clients. */
export class UnityTestCommands implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('Unity Tests');
	private readonly pending = new Map<AbortController, Promise<void>>();
	constructor(ctx: ModuleContext, private readonly tools: UnityTestMcpTools) {
		ctx.registerCommand('unity-cursor-toolkit.tests.list', args => this.start('list_tests', args));
		ctx.registerCommand('unity-cursor-toolkit.tests.run', args => this.start('run_tests', args));
	}
	public async stop(): Promise<void> {
		for (const controller of this.pending.keys()) { controller.abort(); }
		await Promise.allSettled(this.pending.values());
	}
	public dispose(): void { this.output.dispose(); }
	private async start(name: 'list_tests' | 'run_tests', supplied: unknown): Promise<void> {
		const args = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? { ...supplied as Record<string, unknown> } : {};
		if (!args.mode) {
			args.mode = await vscode.window.showQuickPick(['EditMode', 'PlayMode'], { placeHolder: 'Select test mode' });
			if (!args.mode) { return; }
		}
		if (!args.backend) {
			args.backend = await vscode.window.showQuickPick(['auto', 'bridge', 'cli'], { placeHolder: 'Select test backend (CLI requires a closed local project)' });
			if (!args.backend) { return; }
		}
		if (args.filter === undefined) {
			const filter = await vscode.window.showQuickPick(['All tests', 'assembly', 'namespace', 'class', 'test', 'category'], { placeHolder: 'Select an exact test filter' });
			if (!filter) { return; }
			if (filter !== 'All tests') {
				const value = await vscode.window.showInputBox({ prompt: 'Enter the literal ' + filter + ' name', ignoreFocusOut: true });
				if (!value) { return; }
				args.filter = { [filter]: value };
			}
		}
		const controller = new AbortController();
		const operation = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: name === 'list_tests' ? 'List Unity Tests' : 'Run Unity Tests', cancellable: true }, async (progress, token) => {
			const subscription = token.onCancellationRequested(() => controller.abort());
			this.output.show(true);
			try {
				const result = await this.tools.execute(name, args, { signal: controller.signal, reportProgress: (done, total, message) => progress.report({ message: message + ' (' + done + '/' + total + ')' }) });
				this.output.appendLine(result.backend + ' | Unity ' + (result.editorVersion || 'unresolved') + ' | ' + result.mode + ' | ' + result.status + ' | ' + result.runId);
				for (const test of result.tests) {
					this.output.appendLine(test.status + ': ' + test.fullName + ' (' + test.durationMs + ' ms)');
					if (test.message) { this.output.appendLine(test.message); }
					if (test.stackTrace) { this.output.appendLine(test.stackTrace); }
				}
				this.output.appendLine(JSON.stringify(result.summary));
				if (result.error) { this.output.appendLine(result.error.code + ': ' + result.error.message + ' ' + result.error.recovery); }
			} finally { subscription.dispose(); }
		})).then(() => undefined);
		this.pending.set(controller, operation);
		try { await operation; } finally { this.pending.delete(controller); }
	}
}
