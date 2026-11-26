import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IModule, ModuleContext } from '../core/interfaces';
import { getLinkedProjectPath } from '../project/projectHandler';

export class MigrationModule implements IModule {
	public readonly id = 'migration';

	public async activate(ctx: ModuleContext): Promise<void> {
		ctx.registerCommand('unity-cursor-toolkit.migration.scan', async () => {
			try {
				const projectRoot = getLinkedProjectPath() ?? '';
				const { scan } = await import('./index');
				const { formatReport, migrationReportFileName } = await import('./report');
				const result = await scan(projectRoot);
				const reportPath = path.join(projectRoot, migrationReportFileName);
				await fs.writeFile(reportPath, formatReport(result), 'utf8');
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath)));
				vscode.window.showInformationMessage(`CoreCLR migration scan: ${result.scanned} files scanned, ${result.findings.length} findings. Report: ${reportPath}`);
			} catch (error) {
				vscode.window.showErrorMessage(`CoreCLR migration scan failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}

	public async deactivate(): Promise<void> {}
}
