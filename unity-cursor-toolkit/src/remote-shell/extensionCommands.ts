import * as path from 'path';

export interface RemoteShellExtensionSettings {
	readonly manifestPath?: string;
	readonly shellAppPath?: string;
	readonly localPortBase?: number;
}

export interface RemoteShellInvocation {
	readonly command: string;
	readonly args: string[];
}

export function resolveWorkspaceValue(value: string | undefined, workspaceRoot: string): string | undefined {
	if (value == null || value.trim().length === 0) {
		return undefined;
	}

	return value.trim().replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}

export function resolveRemoteShellManifestPath(settings: RemoteShellExtensionSettings, workspaceRoot: string): string {
	const configured = resolveWorkspaceValue(settings.manifestPath, workspaceRoot);
	return configured && path.isAbsolute(configured)
		? path.normalize(configured)
		: path.resolve(workspaceRoot, configured ?? path.join('remote_workspace', 'unity-shell.json'));
}

export function buildRemoteShellInvocation(
	action: 'launch' | 'stop' | 'status' | 'init',
	extensionRoot: string,
	workspaceRoot: string,
	settings: RemoteShellExtensionSettings
): RemoteShellInvocation {
	const sidecarPath = path.join(extensionRoot, 'out', 'remote-shell', 'sidecarCli.js');
	const args = [
		sidecarPath,
		action,
		'--workspace-root', workspaceRoot,
		'--extension-root', extensionRoot,
		'--manifest', resolveRemoteShellManifestPath(settings, workspaceRoot)
	];

	const shellAppPath = resolveWorkspaceValue(settings.shellAppPath, workspaceRoot);
	if (shellAppPath) {
		args.push('--shell-app', shellAppPath);
	}

	if (settings.localPortBase && settings.localPortBase > 0) {
		args.push('--local-port-base', String(Math.floor(settings.localPortBase)));
	}

	return {
		command: process.execPath,
		args
	};
}
