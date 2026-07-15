export type UnityHostLifecycle = 'planned' | 'starting' | 'running' | 'stopped' | 'failed';
export type ShellSurfaceKind = 'ide' | 'unityEditor';
export type RenderBackendKind = 'remoteSidecar' | 'editorWindow' | 'playerCamera';
export type ComputeBackendKind = 'localEditor' | 'remoteMachine';
export type InputRouterKind = 'unityMcp' | 'remoteHttp';
export type UnityHostEndpointKind = 'localIde' | 'localUnityEditor' | 'remoteMachine' | 'remoteUnityPlayer';

export interface UnityHostEndpoint {
	readonly kind: UnityHostEndpointKind;
	readonly label: string;
	readonly address?: string;
	readonly port?: number;
	readonly workspacePath?: string;
	readonly executablePath?: string;
}

export interface ShellSurface {
	readonly kind: ShellSurfaceKind;
	readonly id: string;
	readonly title: string;
	readonly capabilities: readonly string[];
	readonly links?: Record<string, string>;
}

export interface RenderBackend {
	readonly kind: RenderBackendKind;
	readonly id: string;
	readonly label: string;
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
	readonly streamUrl?: string;
	readonly view?: string;
	readonly captureMode?: string;
}

export interface ComputeBackend {
	readonly kind: ComputeBackendKind;
	readonly id: string;
	readonly label: string;
	readonly supportsOffload: boolean;
	readonly sshTarget?: string;
	readonly workspacePath?: string;
	readonly repoPath?: string;
	readonly unityPath?: string;
}

export interface InputRouter {
	readonly kind: InputRouterKind;
	readonly id: string;
	readonly label: string;
	readonly target: string;
	readonly supportedInputs: readonly string[];
}

export interface UnityHostSessionConfig {
	readonly sessionId?: string;
	readonly lifecycle?: UnityHostLifecycle;
	readonly startedAt?: string;
	readonly updatedAt?: string;
	readonly local: UnityHostEndpoint;
	readonly remote?: UnityHostEndpoint;
	readonly surface: ShellSurface;
	readonly render: RenderBackend;
	readonly compute: ComputeBackend;
	readonly input: InputRouter;
}

export interface UnityHostSessionSnapshot extends Required<Omit<UnityHostSessionConfig, 'sessionId' | 'lifecycle' | 'startedAt' | 'updatedAt' | 'remote'>> {
	readonly protocolVersion: 1;
	readonly sessionId: string;
	readonly lifecycle: UnityHostLifecycle;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly remote?: UnityHostEndpoint;
}

export class UnityHostSession {
	private lifecycle: UnityHostLifecycle;
	private updatedAt: string;

	private readonly sessionId: string;
	private readonly startedAt: string;
	private readonly local: UnityHostEndpoint;
	private readonly remote: UnityHostEndpoint | undefined;
	private readonly surface: ShellSurface;
	private readonly render: RenderBackend;
	private readonly compute: ComputeBackend;
	private readonly input: InputRouter;

	public constructor(config: UnityHostSessionConfig) {
		this.sessionId = config.sessionId ?? createSessionId(config.surface.kind);
		this.lifecycle = config.lifecycle ?? 'planned';
		this.startedAt = config.startedAt ?? new Date().toISOString();
		this.updatedAt = config.updatedAt ?? this.startedAt;
		this.local = config.local;
		this.remote = config.remote;
		this.surface = config.surface;
		this.render = config.render;
		this.compute = config.compute;
		this.input = config.input;
	}

	public transition(lifecycle: UnityHostLifecycle, now = new Date().toISOString()): UnityHostSessionSnapshot {
		this.lifecycle = lifecycle;
		this.updatedAt = now;
		return this.snapshot();
	}

	public snapshot(): UnityHostSessionSnapshot {
		return {
			protocolVersion: 1,
			sessionId: this.sessionId,
			lifecycle: this.lifecycle,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			local: this.local,
			remote: this.remote,
			surface: this.surface,
			render: this.render,
			compute: this.compute,
			input: this.input
		};
	}
}

export function createUnityHostSession(config: UnityHostSessionConfig): UnityHostSession {
	return new UnityHostSession(config);
}

export function withSessionLifecycle(snapshot: UnityHostSessionSnapshot, lifecycle: UnityHostLifecycle, now = new Date().toISOString()): UnityHostSessionSnapshot {
	return {
		...snapshot,
		lifecycle,
		updatedAt: now
	};
}

export function createIdeShellSurface(title: string, links: Record<string, string>): ShellSurface {
	return {
		kind: 'ide',
		id: 'ide-shell',
		title,
		capabilities: ['stream-view', 'status', 'remote-control'],
		links
	};
}

export function createUnityEditorShellSurface(view: string, streamUrl?: string): ShellSurface {
	return {
		kind: 'unityEditor',
		id: `unity-editor:${view}`,
		title: `Unity Editor ${view}`,
		capabilities: ['editor-window-capture', 'scene-input', 'game-input'],
		links: streamUrl ? { streamUrl } : undefined
	};
}

export function createRemoteSidecarRenderBackend(options: {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
	readonly streamUrl: string;
}): RenderBackend {
	return {
		kind: 'remoteSidecar',
		id: 'remote-sidecar-mjpeg',
		label: 'Remote sidecar MJPEG stream',
		width: options.width,
		height: options.height,
		fps: options.fps,
		quality: options.quality,
		streamUrl: options.streamUrl
	};
}

export function createEditorWindowRenderBackend(options: {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
	readonly view: string;
	readonly streamUrl?: string;
	readonly captureMode?: string;
}): RenderBackend {
	return {
		kind: 'editorWindow',
		id: `editor-window:${options.view}`,
		label: 'Unity editor window capture',
		width: options.width,
		height: options.height,
		fps: options.fps,
		quality: options.quality,
		view: options.view,
		streamUrl: options.streamUrl,
		captureMode: options.captureMode ?? 'editorWindow'
	};
}

export function createPlayerCameraRenderBackend(options: {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
	readonly streamUrl?: string;
}): RenderBackend {
	return {
		kind: 'playerCamera',
		id: 'player-camera',
		label: 'Unity player camera capture',
		width: options.width,
		height: options.height,
		fps: options.fps,
		quality: options.quality,
		streamUrl: options.streamUrl,
		captureMode: 'camera'
	};
}

export function createRemoteComputeBackend(options: {
	readonly sshTarget: string;
	readonly workspacePath: string;
	readonly repoPath?: string;
	readonly unityPath?: string;
}): ComputeBackend {
	return {
		kind: 'remoteMachine',
		id: `remote:${options.sshTarget}`,
		label: 'Remote Unity compute host',
		supportsOffload: true,
		sshTarget: options.sshTarget,
		workspacePath: options.workspacePath,
		repoPath: options.repoPath,
		unityPath: options.unityPath
	};
}

export function createLocalEditorComputeBackend(): ComputeBackend {
	return {
		kind: 'localEditor',
		id: 'local-unity-editor',
		label: 'Local Unity editor bridge',
		supportsOffload: false
	};
}

export function createHttpInputRouter(controlUrl: string): InputRouter {
	return {
		kind: 'remoteHttp',
		id: 'remote-http-input',
		label: 'Remote sidecar HTTP input router',
		target: controlUrl,
		supportedInputs: ['tap', 'swipe', 'key', 'text', 'wheel', 'pointer']
	};
}

export function createUnityMcpInputRouter(toolName: string): InputRouter {
	return {
		kind: 'unityMcp',
		id: `${toolName}:input`,
		label: 'Unity MCP input router',
		target: toolName,
		supportedInputs: ['tap', 'swipe', 'pointerDown', 'pointerMove', 'pointerUp', 'sceneDrag', 'sceneZoom', 'wheel', 'mouseDelta', 'key', 'text']
	};
}

function createSessionId(prefix: string): string {
	return `${prefix}_${Date.now()}`;
}
