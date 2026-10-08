import * as vscode from 'vscode';
import type { IModule, ModuleContext } from '../core/interfaces';
import { UnityCliAdapter, UnityCliResult, UNITY_CLI_EXPECTED_VERSION } from '../core/unityCliAdapter';

export class UnityCliModule implements IModule {
	public readonly id = 'unity-cli';
	private output: vscode.OutputChannel | undefined;
	private pending: Promise<void> | undefined;
	private controller: AbortController | undefined;

	constructor(private readonly updateStatus: (result: UnityCliResult<{ version: string; expectedVersion: string }>) => void) {}

	public async activate(ctx: ModuleContext): Promise<void> {
		this.output = vscode.window.createOutputChannel('Unity CLI Diagnostics');
		ctx.registerCommand('unity-cursor-toolkit.doctor', () => this.start(true));
		ctx.registerStatusBarContributor({
			group: 'Unity CLI',
			getActions: () => [{ label: 'Unity CLI Doctor', command: 'unity-cursor-toolkit.doctor' }]
		});
		void this.start(false).catch(() => {
			console.error('[UnityCliModule] Diagnostic activation failed.');
		});
	}

	public async deactivate(): Promise<void> {
		this.controller?.abort();
		await this.pending?.catch(() => undefined);
		this.output?.dispose();
		this.output = undefined;
	}

	private start(doctor: boolean): Promise<void> {
		const previous = this.pending;
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		const pending = (async () => {
			await previous?.catch(() => undefined);
			if (controller.signal.aborted) { return; }
			const configuredPath = vscode.workspace.getConfiguration('unityCursorToolkit.unityCli').get<string>('path');
			const adapter = new UnityCliAdapter(configuredPath);
			const probe = await adapter.probe({ timeoutMs: 5000, signal: controller.signal });
			if (controller.signal.aborted) { return; }
			this.updateStatus(probe);
			if (!doctor) { return; }
			this.output?.clear();
			this.output?.show(true);
			this.output?.appendLine('Binary: ' + (probe.binaryPath || 'not found'));
			if (!probe.ok) {
				this.showError(probe);
				if (probe.error.code !== 'version_mismatch') { return; }
			} else {
				const version = typeof probe.data.version === 'string' && probe.data.version.length <= 64
					&& /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|preview)\.\d+)?$/.test(probe.data.version) ? probe.data.version : 'unverified version';
				this.output?.appendLine('Unity CLI: ' + version + ' (expected ' + UNITY_CLI_EXPECTED_VERSION + ')');
			}
			const options = { timeoutMs: 15000, signal: controller.signal };
			const diagnostic = await adapter.invoke('doctor', [], options);
			if (controller.signal.aborted) { return; }
			if (!diagnostic.ok) { this.showError(diagnostic); return; }
			const data = diagnostic.data as { platform?: unknown; arch?: unknown; checks?: unknown } | null;
			if (!data || typeof data.platform !== 'string' || !data.platform || typeof data.arch !== 'string' || !data.arch
				|| !Array.isArray(data.checks) || data.checks.length === 0
				|| !data.checks.every(check => typeof check?.id === 'string' && check.id.length > 0
					&& typeof check.status === 'string' && check.status.length > 0)) {
				this.showError({ ...diagnostic, ok: false, error: {
					code: 'invalid_output', message: 'Unity CLI doctor returned incomplete diagnostic data.',
					recovery: 'Check the pinned CLI installation and inspect its doctor output.'
				} });
				return;
			}
			const ok = data.checks.filter(check => check.status === 'ok').length;
			this.output?.appendLine('Doctor checks: ' + data.checks.length + '; ok: ' + ok + '; other: ' + (data.checks.length - ok) + '.');
			// Auth, account identifiers, recent logs and raw streams are intentionally omitted.
		})();
		this.pending = pending;
		return pending;
	}

	private showError(result: Extract<UnityCliResult, { ok: false }>): void {
		const error = result.error;
		const text = error.code + (error.code === 'version_mismatch'
			? ': Unity CLI version does not match the pinned version.'
			: ': Unity CLI diagnostics failed. Check the pinned CLI installation and configuration.');
		this.output?.appendLine(text);
		if (error.code === 'version_mismatch') { void vscode.window.showWarningMessage(text); }
		else { void vscode.window.showErrorMessage(text); }
	}
}
