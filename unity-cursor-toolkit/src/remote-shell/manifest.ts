import * as fs from 'fs';
import * as path from 'path';

export interface RemoteShellDisplay {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
}

export interface RemoteShellPorts {
	readonly stream: number;
	readonly control: number;
}

export interface RemoteShellManifest {
	readonly sshTarget: string;
	readonly remoteWorkspacePath: string;
	readonly remoteRepoPath?: string;
	readonly unityEditorPath?: string;
	readonly unityPlayerPath: string;
	readonly vddMonitor: number;
	readonly display: RemoteShellDisplay;
	readonly ports: RemoteShellPorts;
	readonly windowTitle: string;
	readonly ffmpegPath: string;
	readonly remoteSidecarPath: string;
}

export interface RemoteShellManifestLoadResult {
	readonly manifest: RemoteShellManifest;
	readonly manifestPath: string;
}

const DEFAULT_DISPLAY: RemoteShellDisplay = {
	width: 1280,
	height: 720,
	fps: 30,
	quality: 70
};

const DEFAULT_PORTS: RemoteShellPorts = {
	stream: 48170,
	control: 48171
};

export function resolveManifestPath(workspaceRoot: string, configuredPath?: string): string {
	const rawPath = configuredPath && configuredPath.trim().length > 0
		? configuredPath.trim()
		: path.join('remote_workspace', 'unity-shell.json');
	const expanded = rawPath.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(workspaceRoot, expanded);
}

export async function loadRemoteShellManifest(manifestPath: string): Promise<RemoteShellManifestLoadResult> {
	const content = await fs.promises.readFile(manifestPath, 'utf8');
	return {
		manifest: parseRemoteShellManifest(JSON.parse(content)),
		manifestPath
	};
}

export function parseRemoteShellManifest(input: unknown): RemoteShellManifest {
	if (isRecord(input) === false) {
		throw new Error('Remote shell manifest must be a JSON object.');
	}

	const record = input as Record<string, unknown>;
	const remoteWorkspacePath = requireString(record, 'remoteWorkspacePath');
	return {
		sshTarget: requireString(record, 'sshTarget'),
		remoteWorkspacePath,
		remoteRepoPath: readString(record, 'remoteRepoPath', ''),
		unityEditorPath: readString(record, 'unityEditorPath', ''),
		unityPlayerPath: requireString(record, 'unityPlayerPath'),
		vddMonitor: readPositiveInteger(record, 'vddMonitor', 2),
		display: parseDisplay(record.display),
		ports: parsePorts(record.ports),
		windowTitle: readString(record, 'windowTitle', 'Unity VDD Shell'),
		ffmpegPath: readString(record, 'ffmpegPath', 'ffmpeg'),
		remoteSidecarPath: readString(record, 'remoteSidecarPath', joinWindowsPath(remoteWorkspacePath, 'tools', 'unity-vdd-shell', 'unity-vdd-sidecar.ps1'))
	};
}

export function createExampleManifest(): RemoteShellManifest {
	const remoteWorkspacePath = 'C:\\remote_workspace\\unity-shell-demo';
	return {
		sshTarget: 'unity-vdd-host',
		remoteWorkspacePath,
		remoteRepoPath: 'C:\\remote_workspace\\unity-cursor-toolkit',
		unityEditorPath: 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.9f1\\Editor\\Unity.exe',
		unityPlayerPath: 'C:\\remote_workspace\\unity-shell-demo\\Build\\UnityShellDemo.exe',
		vddMonitor: 2,
		display: DEFAULT_DISPLAY,
		ports: DEFAULT_PORTS,
		windowTitle: 'Unity VDD Shell',
		ffmpegPath: 'ffmpeg',
		remoteSidecarPath: joinWindowsPath(remoteWorkspacePath, 'tools', 'unity-vdd-shell', 'unity-vdd-sidecar.ps1')
	};
}

export function joinWindowsPath(root: string, ...segments: string[]): string {
	const trimmedRoot = root.replace(/[\\\/]+$/, '');
	const cleaned = segments.map((segment) => segment.replace(/^[\\\/]+|[\\\/]+$/g, ''));
	return [trimmedRoot, ...cleaned].filter(Boolean).join('\\');
}

function parseDisplay(input: unknown): RemoteShellDisplay {
	const record = isRecord(input) ? input : {};
	return {
		width: readPositiveInteger(record, 'width', DEFAULT_DISPLAY.width),
		height: readPositiveInteger(record, 'height', DEFAULT_DISPLAY.height),
		fps: readPositiveInteger(record, 'fps', DEFAULT_DISPLAY.fps),
		quality: clamp(readPositiveInteger(record, 'quality', DEFAULT_DISPLAY.quality), 1, 100)
	};
}

function parsePorts(input: unknown): RemoteShellPorts {
	const record = isRecord(input) ? input : {};
	const stream = readPositiveInteger(record, 'stream', DEFAULT_PORTS.stream);
	const control = readPositiveInteger(record, 'control', DEFAULT_PORTS.control);
	if (stream === control) {
		throw new Error('Remote shell stream and control ports must be different.');
	}

	return { stream, control };
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = readString(record, key, '');
	if (value.length === 0) {
		throw new Error(`Remote shell manifest is missing required string field "${key}".`);
	}
	return value;
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
	const value = record[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readPositiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
	const value = record[key];
	if (value == null) {
		return fallback;
	}

	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isFinite(parsed) === false || parsed <= 0) {
		throw new Error(`Remote shell manifest field "${key}" must be a positive integer.`);
	}

	return Math.floor(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && Array.isArray(value) === false;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function isFullyQualifiedWindowsPath(value: string): boolean {
	return path.win32.isAbsolute(value) && /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value);
}

/** Doctor validation is stricter than the shipped launch parser. */
export function parseRemoteShellDoctorManifest(input: unknown): RemoteShellManifest {
	if (!isRecord(input)) { throw new Error('Invalid doctor manifest.'); }
	for (const key of ['sshTarget', 'remoteWorkspacePath', 'remoteRepoPath', 'unityEditorPath', 'unityPlayerPath', 'windowTitle', 'ffmpegPath', 'remoteSidecarPath']) {
		const value = input[key];
		if (value !== undefined && (typeof value !== 'string' || /[\x00-\x1f]/.test(value)
			|| (!['remoteRepoPath', 'unityEditorPath'].includes(key) && value.trim().length === 0))) { throw new Error('Invalid doctor manifest string.'); }
	}
	for (const [key, fields] of [['display', ['width', 'height', 'fps', 'quality']], ['ports', ['stream', 'control']]] as const) {
		const value = input[key];
		if (value !== undefined && !isRecord(value)) { throw new Error('Invalid doctor manifest object.'); }
		if (isRecord(value)) {
			for (const field of fields) {
				const number = value[field];
				if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0
					|| (key === 'ports' && number > 65535) || (field === 'quality' && number > 100))) { throw new Error('Invalid doctor manifest number.'); }
			}
		}
	}
	if (input.vddMonitor !== undefined && (typeof input.vddMonitor !== 'number' || !Number.isSafeInteger(input.vddMonitor) || input.vddMonitor <= 0)) { throw new Error('Invalid doctor monitor.'); }
	const manifest = parseRemoteShellManifest(input);
	if (!/^(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(manifest.sshTarget)) { throw new Error('Invalid doctor SSH target.'); }
	for (const value of [manifest.remoteWorkspacePath, manifest.unityPlayerPath, manifest.remoteSidecarPath, manifest.remoteRepoPath, manifest.unityEditorPath]) {
		if (value && (!isFullyQualifiedWindowsPath(value) || value.includes('$' + '{'))) { throw new Error('Unresolved doctor remote path.'); }
	}
	if (!/\.ps1$/i.test(manifest.remoteSidecarPath)) { throw new Error('Invalid doctor sidecar script path.'); }
	if (/[\*?\[\]]/.test(manifest.ffmpegPath)
		|| (/[\\/:]/.test(manifest.ffmpegPath) && !isFullyQualifiedWindowsPath(manifest.ffmpegPath))) { throw new Error('Unresolved doctor FFmpeg path.'); }
	if ([manifest.sshTarget, manifest.ffmpegPath].some(value => value.includes('$' + '{'))) { throw new Error('Unresolved doctor value.'); }
	return manifest;
}
