/**
 * Project Module -- Unity project detection, meta file management,
 * welcome screen, folder templates, csproj generation.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import {
	handleUnityProjectSetup,
	hasLinkedUnityProject,
	getLinkedProjectPath,
	initializeUnityProjectHandler,
	clearLinkedProjectOnExit,
	isScriptInstalledInLinkedProject,
	isUpmPackageInstalled,
	checkAndUpdateUpmVersion,
	warnLegacyScripts
} from './projectHandler';
import { MetaManager } from './metaManager';
import { ProjectMcpTools } from './projectMcpTools';

export class ProjectModule implements IModule {

	public readonly id = 'project';

	private metaManager: MetaManager | undefined;
	private disposables: vscode.Disposable[] = [];

	public async activate(ctx: ModuleContext): Promise<void> {
		initializeUnityProjectHandler(ctx.extensionContext);

		this.metaManager = new MetaManager();
		this.disposables.push(this.metaManager);

		ctx.registerCommand('unity-cursor-toolkit.resolveMeta', async () => {
			await this.metaManager?.resolveMetaInteractive();
		});

		ctx.registerCommand('unity-cursor-toolkit.openProject', async () => {
			const { openOrCreateWorkspace } = await import('./welcomePanel');
			await openOrCreateWorkspace();
		});

		ctx.registerCommand('unity-cursor-toolkit.generateFolderStructure', async () => {
			const { pickAndGenerateTemplate } = await import('./folderTemplates');
			await pickAndGenerateTemplate();
		});

		ctx.registerToolProvider(new ProjectMcpTools(this.metaManager!));
		ctx.registerStatusBarContributor(new ProjectStatusContributor());
	}

	public async deactivate(): Promise<void> {
		clearLinkedProjectOnExit();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

export {
	handleUnityProjectSetup,
	hasLinkedUnityProject,
	getLinkedProjectPath,
	isScriptInstalledInLinkedProject,
	isUpmPackageInstalled,
	checkAndUpdateUpmVersion,
	warnLegacyScripts
};

class ProjectStatusContributor implements IStatusBarContributor {

	public readonly group = 'Project';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(folder-opened) Open Project', command: 'unity-cursor-toolkit.openProject' },
			{ label: '$(file-directory-create) Generate Folder Structure', command: 'unity-cursor-toolkit.generateFolderStructure' }
		];
	}
}
