import * as path from 'path';
import type { RemoteShellManifest } from './manifest';
import {
	createHttpInputRouter,
	createIdeShellSurface,
	createRemoteComputeBackend,
	createRemoteSidecarRenderBackend,
	createUnityHostSession,
	type UnityHostSessionSnapshot
} from './session';

export interface CommandPlan {
	readonly command: string;
	readonly args: string[];
}

export interface RemoteShellLinks {
	readonly streamUrl: string;
	readonly latestFrameUrl: string;
	readonly controlUrl: string;
	readonly statusUrl: string;
}

export interface RemoteShellPlanOptions {
	readonly manifestPath: string;
	readonly extensionRoot: string;
	readonly localPortBase?: number;
	readonly shellAppPath?: string;
}

export interface RemoteShellPlan {
	readonly manifestPath: string;
	readonly localStreamPort: number;
	readonly localControlPort: number;
	readonly links: RemoteShellLinks;
	readonly session: UnityHostSessionSnapshot;
	readonly sshTunnel: CommandPlan;
	readonly remoteStart: CommandPlan;
	readonly shellLaunch: CommandPlan;
	readonly statePath: string;
}

export function createRemoteShellPlan(manifest: RemoteShellManifest, options: RemoteShellPlanOptions): RemoteShellPlan {
	const localStreamPort = options.localPortBase && options.localPortBase > 0 ? Math.floor(options.localPortBase) : manifest.ports.stream;
	const localControlPort = localStreamPort === manifest.ports.control ? localStreamPort + 1 : localStreamPort + 1;
	const links = createRemoteShellLinks(localStreamPort, localControlPort);
	const statePath = path.join(path.dirname(options.manifestPath), '.unity-vdd-shell', 'session.json');
	const shellLaunch = buildShellLaunchPlan(manifest, options, links);
	const session = createUnityHostSession({
		sessionId: `remote-shell:${manifest.sshTarget}:${manifest.ports.stream}:${manifest.ports.control}`,
		local: {
			kind: 'localIde',
			label: 'Local IDE shell',
			address: '127.0.0.1',
			workspacePath: path.dirname(options.manifestPath)
		},
		remote: {
			kind: 'remoteMachine',
			label: manifest.sshTarget,
			workspacePath: manifest.remoteWorkspacePath,
			executablePath: manifest.unityPlayerPath
		},
		surface: createIdeShellSurface(manifest.windowTitle, {
			streamUrl: links.streamUrl,
			latestFrameUrl: links.latestFrameUrl,
			controlUrl: links.controlUrl,
			statusUrl: links.statusUrl
		}),
		render: createRemoteSidecarRenderBackend({
			width: manifest.display.width,
			height: manifest.display.height,
			fps: manifest.display.fps,
			quality: manifest.display.quality,
			streamUrl: links.streamUrl
		}),
		compute: createRemoteComputeBackend({
			sshTarget: manifest.sshTarget,
			workspacePath: manifest.remoteWorkspacePath,
			repoPath: manifest.remoteRepoPath,
			unityPath: manifest.unityEditorPath || manifest.unityPlayerPath
		}),
		input: createHttpInputRouter(links.controlUrl)
	}).snapshot();

	return {
		manifestPath: options.manifestPath,
		localStreamPort,
		localControlPort,
		links,
		session,
		sshTunnel: {
			command: 'ssh',
			args: [
				'-N',
				'-L', `${localStreamPort}:127.0.0.1:${manifest.ports.stream}`,
				'-L', `${localControlPort}:127.0.0.1:${manifest.ports.control}`,
				manifest.sshTarget
			]
		},
		remoteStart: {
			command: 'ssh',
			args: [manifest.sshTarget, buildRemoteStartCommand(manifest)]
		},
		shellLaunch,
		statePath
	};
}

export function createRemoteShellLinks(localStreamPort: number, localControlPort: number): RemoteShellLinks {
	const streamBase = `http://127.0.0.1:${localStreamPort}`;
	const controlBase = `http://127.0.0.1:${localControlPort}`;
	return {
		streamUrl: `${streamBase}/viewport.mjpg`,
		latestFrameUrl: `${streamBase}/latest.jpg`,
		controlUrl: controlBase,
		statusUrl: `${controlBase}/status.json`
	};
}

export function buildRemoteStartCommand(manifest: RemoteShellManifest): string {
	const args = [
		'-NoProfile',
		'-ExecutionPolicy', 'Bypass',
		'-File', quotePowerShell(manifest.remoteSidecarPath),
		'-WorkspacePath', quotePowerShell(manifest.remoteWorkspacePath),
		'-UnityPlayerPath', quotePowerShell(manifest.unityPlayerPath),
		'-WindowTitle', quotePowerShell(manifest.windowTitle),
		'-Monitor', String(manifest.vddMonitor),
		'-Width', String(manifest.display.width),
		'-Height', String(manifest.display.height),
		'-Fps', String(manifest.display.fps),
		'-Quality', String(manifest.display.quality),
		'-StreamPort', String(manifest.ports.stream),
		'-ControlPort', String(manifest.ports.control),
		'-FfmpegPath', quotePowerShell(manifest.ffmpegPath)
	];
	return `powershell.exe ${args.join(' ')}`;
}

export function buildShellLaunchPlan(manifest: RemoteShellManifest, options: RemoteShellPlanOptions, links: RemoteShellLinks): CommandPlan {
	const shellArgs = [
		'--manifest', options.manifestPath,
		'--stream-url', links.streamUrl,
		'--control-url', links.controlUrl,
		'--title', manifest.windowTitle
	];

	if (options.shellAppPath && options.shellAppPath.trim().length > 0) {
		const shellAppPath = options.shellAppPath.trim();
		if (shellAppPath.endsWith('.app')) {
			return {
				command: 'open',
				args: ['-a', shellAppPath, '--args', ...shellArgs]
			};
		}

		return {
			command: shellAppPath,
			args: shellArgs
		};
	}

	const packagePath = path.join(options.extensionRoot, 'native-shell', 'UnityVddShell');
	const scratchPath = path.join(path.dirname(options.manifestPath), '.unity-vdd-shell', 'swift-build');
	return {
		command: 'swift',
		args: ['run', '--package-path', packagePath, '--scratch-path', scratchPath, 'UnityVddShell', '--', ...shellArgs]
	};
}

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** Sidecar identity contract version, independent of extension releases. */
export const REMOTE_SHELL_SIDECAR_VERSION = '1.0.0';

export function createRemoteShellDoctorPlans(manifest: RemoteShellManifest): { ssh: CommandPlan; remotepaths: CommandPlan; sidecarversion: CommandPlan } {
	const encoded = (script: string): CommandPlan => ({
		command: 'ssh',
		args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
			'-o', 'ConnectionAttempts=1', '-o', 'UpdateHostKeys=no', '-o', 'PermitLocalCommand=no',
			'-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'Tunnel=no',
			'-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ForkAfterAuthentication=no', manifest.sshTarget,
			'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64')]
	});
	const checks = [
		"workspace=(Test-Path -LiteralPath " + quotePowerShell(manifest.remoteWorkspacePath) + " -PathType Container)",
		"player=(Test-Path -LiteralPath " + quotePowerShell(manifest.unityPlayerPath) + " -PathType Leaf)",
		"sidecar=(Test-Path -LiteralPath " + quotePowerShell(manifest.remoteSidecarPath) + " -PathType Leaf)",
		"ffmpeg=([bool](Get-Command -Name " + quotePowerShell(manifest.ffmpegPath) + " -CommandType Application -ErrorAction SilentlyContinue))"
	];
	if (manifest.unityEditorPath) { checks.push("editor=(Test-Path -LiteralPath " + quotePowerShell(manifest.unityEditorPath) + " -PathType Leaf)"); }
	if (manifest.remoteRepoPath) { checks.push("repo=(Test-Path -LiteralPath " + quotePowerShell(manifest.remoteRepoPath) + " -PathType Container)"); }
	return {
		ssh: encoded('[Console]::Write(\'{"reachable":true}\')'),
		remotepaths: encoded('@{' + checks.join(';') + '} | ConvertTo-Json -Compress'),
		sidecarversion: encoded('& ' + quotePowerShell(manifest.remoteSidecarPath) + ' -VersionOnly')
	};
}
