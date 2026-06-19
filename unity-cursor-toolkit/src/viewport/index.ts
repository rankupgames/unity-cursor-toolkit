import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import type { IMessageHandler, IModule, ModuleContext, IStatusBarContributor, QuickAccessAction } from '../core/interfaces';
import { ConnectionState } from '../core/types';

type BuiltInViewMode = 'scene' | 'game' | 'inspector' | 'packageManager';
type ViewMode = BuiltInViewMode | `window:${string}`;
type ViewHost = 'editor' | 'player';
type ProofStatus = 'running' | 'pass' | 'fail';

const PROOF_PANEL_REOPEN_INTERVAL_MS = 5_000;

interface ViewportInputProofStep {
	readonly inputType: string;
	readonly success: boolean;
	readonly layer: string | null;
	readonly result: unknown;
	readonly error?: string;
}

interface ViewportInputProof extends ViewportInputProofStep {
	readonly attemptedAt: string;
	readonly followUp?: ViewportInputProofStep;
}

interface HierarchyNode {
	readonly name: string;
	readonly instanceId?: number;
	readonly children: HierarchyNode[];
}

interface ViewportOptions {
	readonly aspect: string;
	readonly fps: number;
	readonly quality: number;
	readonly gizmos: boolean;
	readonly twoD: boolean;
	readonly sceneTool: string;
	readonly sceneSpace: string;
	readonly gameCursorLock: boolean;
}

interface ViewportFramePayload {
	readonly sessionId?: unknown;
	readonly path?: unknown;
	readonly data?: unknown;
	readonly sequence?: unknown;
	readonly width?: unknown;
	readonly height?: unknown;
	readonly flippedVertical?: unknown;
	readonly timestamp?: unknown;
}

interface ViewportWebviewMessage {
	readonly type?: unknown;
	readonly name?: unknown;
	readonly value?: unknown;
	readonly inputType?: unknown;
	readonly x?: unknown;
	readonly y?: unknown;
	readonly x2?: unknown;
	readonly y2?: unknown;
	readonly dx?: unknown;
	readonly dy?: unknown;
	readonly wheelDelta?: unknown;
	readonly button?: unknown;
	readonly key?: unknown;
	readonly text?: unknown;
}

interface ViewportPanelState {
	readonly mode: ViewMode;
	readonly host: ViewHost;
	connectionState: ConnectionState;
	streaming: boolean;
	status: string;
	frame?: {
		readonly dataUri: string;
		readonly sequence: number;
			readonly width: number;
			readonly height: number;
			readonly flippedVertical: boolean;
			readonly timestamp: string;
		};
	options: ViewportOptions;
}

export class ViewportPrototypeModule implements IModule, IMessageHandler {
	public readonly id = 'viewport-prototype';
	public readonly commandFilter = 'viewportFrame';

	private ctx: ModuleContext | undefined;
	private hierarchyProvider: UnityHierarchyProvider | undefined;
	private hierarchyView: vscode.TreeView<HierarchyItem> | undefined;
	private scenePanel: UnityViewportPanel | undefined;
	private gamePanel: UnityViewportPanel | undefined;
	private playerScenePanel: UnityViewportPanel | undefined;
	private playerGamePanel: UnityViewportPanel | undefined;
	private inspectorPanel: UnityViewportPanel | undefined;
	private packageManagerPanel: UnityViewportPanel | undefined;
	private readonly customPanels = new Map<ViewMode, UnityViewportPanel>();
	private disposables: vscode.Disposable[] = [];
	private automatedProofStarted = false;

	public async activate(ctx: ModuleContext): Promise<void> {
		this.ctx = ctx;
		this.hierarchyProvider = new UnityHierarchyProvider(ctx);
		this.hierarchyView = vscode.window.createTreeView('unityHierarchy', {
			treeDataProvider: this.hierarchyProvider,
			showCollapseAll: true
		});

		ctx.registerMessageHandler(this);
		ctx.registerCommand('unity-cursor-toolkit.viewport.openPrototype', () => this.openSceneView());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openSceneView', () => this.openSceneView());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openGameView', () => this.openGameView());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openPlayerSceneView', () => this.openPlayerSceneView());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openPlayerGameView', () => this.openPlayerGameView());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openInspector', () => this.openInspector());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openPackageManager', () => this.openPackageManager());
		ctx.registerCommand('unity-cursor-toolkit.viewport.openCustomWindow', (typeName?: unknown) => {
			void this.openCustomWindow(typeof typeName === 'string' ? typeName : undefined);
		});
		ctx.registerCommand('unity-cursor-toolkit.hierarchy.refresh', async () => {
			await this.ensureConnectedForHierarchy();
			await this.hierarchyProvider?.refresh();
		});
		ctx.registerCommand('unity-cursor-toolkit.hierarchy.focus', async () => {
			await this.focusHierarchy();
		});
		ctx.registerCommand('unity-cursor-toolkit.hierarchy.openSceneView', () => this.openSceneView());
		ctx.registerCommand('unity-cursor-toolkit.hierarchy.openGameView', () => this.openGameView());
		ctx.registerStatusBarContributor(new ViewportStatusBarContributor());

		this.disposables.push(
			this.hierarchyView,
			ctx.connectionManager.onStateChanged((info) => {
				this.forEachPanel((panel) => panel.handleConnectionState(info.state));
				if (info.state === ConnectionState.Connected) {
					void this.hierarchyProvider?.refresh();
				}
			})
		);

		this.startAutomatedEditorSceneGameProofIfRequested();
	}

	public async deactivate(): Promise<void> {
		await this.scenePanel?.dispose();
		await this.gamePanel?.dispose();
		await this.playerScenePanel?.dispose();
		await this.playerGamePanel?.dispose();
		await this.inspectorPanel?.dispose();
		await this.packageManagerPanel?.dispose();
		const customPanels = Array.from(this.customPanels.values());
		this.customPanels.clear();
		for (const panel of customPanels) {
			await panel.dispose();
		}
		this.scenePanel = undefined;
		this.gamePanel = undefined;
		this.playerScenePanel = undefined;
		this.playerGamePanel = undefined;
		this.inspectorPanel = undefined;
		this.packageManagerPanel = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}

	public handle(payload: Record<string, unknown>): void {
		const frame = payload as ViewportFramePayload;
		this.forEachPanel((panel) => {
			void panel.handleViewportFrame(frame);
		});
	}

	private openSceneView(): void {
		this.openView('scene', 'editor');
	}

	private openGameView(): void {
		this.openView('game', 'editor');
	}

	private openPlayerSceneView(): void {
		this.openView('scene', 'player');
	}

	private openPlayerGameView(): void {
		this.openView('game', 'player');
	}

	private openInspector(): void {
		this.openView('inspector', 'editor');
	}

	private openPackageManager(): void {
		this.openView('packageManager', 'editor');
	}

	private async openCustomWindow(typeName?: string): Promise<void> {
		const rawTypeName = typeof typeName === 'string' && typeName.trim().length > 0
			? typeName.trim()
			: await vscode.window.showInputBox({
				title: 'Open Unity EditorWindow',
				prompt: 'Full EditorWindow type name, for example MyCompany.Tools.MyWindow',
				placeHolder: 'Namespace.TypeName'
			});
		const normalizedTypeName = typeof rawTypeName === 'string' ? rawTypeName.trim() : '';
		if (normalizedTypeName.length === 0) {
			return;
		}

		this.openView(`window:${normalizedTypeName}`, 'editor');
	}

	private openView(mode: ViewMode, host: ViewHost): void {
		const ctx = this.requireContext();
		let panel = this.getPanel(mode, host);
		if (panel == null) {
			panel = new UnityViewportPanel(ctx, mode, host, () => {
				this.clearPanel(mode, host);
			});
			this.setPanel(mode, host, panel);
		}
		panel.reveal(true);
	}

	private getPanel(mode: ViewMode, host: ViewHost): UnityViewportPanel | undefined {
		if (host === 'player') {
			switch (mode) {
				case 'game':
					return this.playerGamePanel;
				case 'scene':
					return this.playerScenePanel;
				default:
					return undefined;
			}
		}

		switch (mode) {
			case 'game':
				return this.gamePanel;
			case 'inspector':
				return this.inspectorPanel;
			case 'packageManager':
				return this.packageManagerPanel;
			case 'scene':
				return this.scenePanel;
			default:
				return this.customPanels.get(mode);
		}
	}

	private setPanel(mode: ViewMode, host: ViewHost, panel: UnityViewportPanel): void {
		if (host === 'player') {
			switch (mode) {
				case 'game':
					this.playerGamePanel = panel;
					return;
				case 'scene':
					this.playerScenePanel = panel;
					return;
				default:
					return;
			}
		}

		switch (mode) {
			case 'game':
				this.gamePanel = panel;
				return;
			case 'inspector':
				this.inspectorPanel = panel;
				return;
			case 'packageManager':
				this.packageManagerPanel = panel;
				return;
			case 'scene':
				this.scenePanel = panel;
				return;
			default:
				this.customPanels.set(mode, panel);
		}
	}

	private clearPanel(mode: ViewMode, host: ViewHost): void {
		if (host === 'player') {
			switch (mode) {
				case 'game':
					this.playerGamePanel = undefined;
					return;
				case 'scene':
					this.playerScenePanel = undefined;
					return;
				default:
					return;
			}
		}

		switch (mode) {
			case 'game':
				this.gamePanel = undefined;
				return;
			case 'inspector':
				this.inspectorPanel = undefined;
				return;
			case 'packageManager':
				this.packageManagerPanel = undefined;
				return;
			case 'scene':
				this.scenePanel = undefined;
				return;
			default:
				this.customPanels.delete(mode);
		}
	}

	private forEachPanel(callback: (panel: UnityViewportPanel) => void): void {
		for (const panel of [this.scenePanel, this.gamePanel, this.playerScenePanel, this.playerGamePanel, this.inspectorPanel, this.packageManagerPanel]) {
			if (panel) {
				callback(panel);
			}
		}
		for (const panel of this.customPanels.values()) {
			callback(panel);
		}
	}

	private async focusHierarchy(): Promise<void> {
		await vscode.commands.executeCommand('workbench.view.extension.unityCursorToolkit');
		await vscode.commands.executeCommand('unityHierarchy.focus');
		await this.ensureConnectedForHierarchy();
		await this.hierarchyProvider?.refresh();
	}

	private async ensureConnectedForHierarchy(): Promise<void> {
		const ctx = this.requireContext();
		if (ctx.connectionManager.info.state === ConnectionState.Connected) {
			return;
		}

		await vscode.commands.executeCommand('unity-cursor-toolkit.startConnection');
	}

	private startAutomatedEditorSceneGameProofIfRequested(): void {
		const config = vscode.workspace.getConfiguration();
		const proofPath = firstNonEmpty(
			process.env.UNITY_CURSOR_TOOLKIT_VIEWPORT_PROOF_OUT,
			config.get<string>('unityCursorToolkit.viewportProof.out', '')
		);
		if (this.automatedProofStarted || proofPath == null || proofPath.trim().length === 0) {
			return;
		}

		this.automatedProofStarted = true;
		const startedAt = new Date();
		const timeoutMs = parsePositiveInt(
			process.env.UNITY_CURSOR_TOOLKIT_VIEWPORT_PROOF_TIMEOUT_MS,
			config.get<number>('unityCursorToolkit.viewportProof.timeoutMs', 90_000)
		);
		const run = async (): Promise<void> => {
			let nextPanelOpenAt = 0;
			const openMissingPanels = (scene?: Record<string, unknown>, game?: Record<string, unknown>): void => {
				const now = Date.now();
				if (now < nextPanelOpenAt) {
					return;
				}
				if (isProofFrameReady(scene) === false) {
					this.openSceneView();
				}
				if (isProofFrameReady(game) === false) {
					this.openGameView();
				}
				nextPanelOpenAt = now + PROOF_PANEL_REOPEN_INTERVAL_MS;
			};

			await this.writeAutomatedEditorSceneGameProof(proofPath, 'running', startedAt);
			openMissingPanels();

			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const scene = this.scenePanel?.getProofState();
				const game = this.gamePanel?.getProofState();
				if (isProofFrameReady(scene) && isProofFrameReady(game)) {
					if (isProofInputReady(scene) === false) {
						await this.scenePanel?.runProofInput();
					}
					if (isProofInputReady(game) === false) {
						await this.gamePanel?.runProofInput();
					}
					const nextScene = this.scenePanel?.getProofState();
					const nextGame = this.gamePanel?.getProofState();
					if (isProofInputReady(nextScene) && isProofInputReady(nextGame)) {
						await this.writeAutomatedEditorSceneGameProof(proofPath, 'pass', startedAt);
						return;
					}
				}
				openMissingPanels(scene, game);
				await this.writeAutomatedEditorSceneGameProof(proofPath, 'running', startedAt);
				await sleep(500);
			}

			await this.writeAutomatedEditorSceneGameProof(proofPath, 'fail', startedAt, `Timed out after ${timeoutMs}ms waiting for live editor Scene/Game frames and editor-window input proof.`);
		};

		void run().catch((error: unknown) => {
			void this.writeAutomatedEditorSceneGameProof(proofPath, 'fail', startedAt, error instanceof Error ? error.message : String(error));
		});
	}

	private async writeAutomatedEditorSceneGameProof(proofPath: string, status: ProofStatus, startedAt: Date, error?: string): Promise<void> {
		const ctx = this.requireContext();
		const extension = ctx.extensionContext.extension;
		const packageJson = extension.packageJSON as { version?: unknown } | undefined;
		const report = {
			schemaVersion: 1,
			proofMode: 'installed-cursor-editor-scene-game',
			status,
			generatedAt: new Date().toISOString(),
			startedAt: startedAt.toISOString(),
			finishedAt: status === 'running' ? null : new Date().toISOString(),
			extension: {
				id: extension.id,
				version: typeof packageJson?.version === 'string' ? packageJson.version : null
			},
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
			connection: {
				state: ctx.connectionManager.info.state,
				port: ctx.connectionManager.info.port
			},
			panels: {
				sceneView: this.scenePanel?.getProofState() ?? null,
				gameView: this.gamePanel?.getProofState() ?? null
			},
			...(error ? { error } : {})
		};
		await fs.mkdir(dirname(proofPath), { recursive: true });
		await fs.writeFile(proofPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	}

	private requireContext(): ModuleContext {
		if (this.ctx == null) {
			throw new Error('Viewport module is not active.');
		}
		return this.ctx;
	}
}

class UnityHierarchyProvider implements vscode.TreeDataProvider<HierarchyItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HierarchyItem | undefined>();
	public readonly onDidChangeTreeData: vscode.Event<HierarchyItem | undefined> = this.onDidChangeTreeDataEmitter.event;

	private roots: HierarchyNode[] = [];
	private status = 'Unity disconnected';

	constructor(private readonly ctx: ModuleContext) {}

	public getTreeItem(element: HierarchyItem): vscode.TreeItem {
		return element;
	}

	public getChildren(element?: HierarchyItem): HierarchyItem[] {
		if (element) {
			return element.node.children.map((node) => new HierarchyItem(node));
		}

		if (this.roots.length === 0) {
			return [HierarchyItem.message(this.status)];
		}

		return this.roots.map((node) => new HierarchyItem(node));
	}

	public async refresh(): Promise<void> {
		if (this.ctx.connectionManager.info.state !== ConnectionState.Connected) {
			this.roots = [];
			this.status = 'Unity disconnected';
			this.onDidChangeTreeDataEmitter.fire(undefined);
			return;
		}

		this.status = 'Refreshing hierarchy';
		this.onDidChangeTreeDataEmitter.fire(undefined);
		const response = await this.ctx.commandSender.request('mcpToolCall', {
			toolName: 'manage_scene',
			args: { action: 'getHierarchy' }
		});
		const parsed = parseToolJson(response?.result);
		this.roots = parseHierarchyRoots(parsed);
		this.status = this.roots.length > 0 ? 'Hierarchy loaded' : 'Hierarchy is empty';
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}
}

class HierarchyItem extends vscode.TreeItem {
	public static message(text: string): HierarchyItem {
		const item = new HierarchyItem({ name: text, children: [] });
		item.contextValue = 'unityHierarchyMessage';
		item.iconPath = new vscode.ThemeIcon('info');
		return item;
	}

	constructor(public readonly node: HierarchyNode) {
		super(node.name, node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.id = typeof node.instanceId === 'number' ? String(node.instanceId) : `node:${node.name}`;
		this.description = typeof node.instanceId === 'number' ? String(node.instanceId) : undefined;
		this.contextValue = 'unityGameObject';
		this.iconPath = new vscode.ThemeIcon(node.children.length > 0 ? 'symbol-namespace' : 'symbol-object');
		this.tooltip = typeof node.instanceId === 'number' ? `${node.name} (${node.instanceId})` : node.name;
	}
}

class UnityViewportPanel {
	private panel: vscode.WebviewPanel | undefined;
	private sessionId: string | undefined;
	private healthTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingStartStream: Promise<void> | undefined;
	private autoStartRequested = false;
	private inputProof: ViewportInputProof | undefined;
	private disposed = false;
	private readonly state: ViewportPanelState;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly ctx: ModuleContext,
		private readonly mode: ViewMode,
		private readonly host: ViewHost,
		private readonly onDispose: () => void
	) {
		this.state = createInitialPanelState(mode, host, ctx.connectionManager.info.state);
	}

	public reveal(autoStart = false): void {
		if (this.disposed) {
			return;
		}

		if (autoStart) {
			this.autoStartRequested = true;
		}

		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Beside);
			this.postState();
			if (autoStart) {
				this.requestAutoStart();
			}
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			panelTypeForMode(this.mode, this.host),
			`Unity ${this.title}`,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);
		this.panel.webview.html = this.getHtml(this.panel.webview);
		this.disposables.push(
			this.panel.onDidDispose(() => {
				void this.dispose();
			}),
			this.panel.webview.onDidReceiveMessage((message: ViewportWebviewMessage) => {
				this.handleWebviewMessage(message).catch((error: unknown) => {
					this.setStatus(`Viewport action failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			})
		);
		this.postState();
		if (autoStart) {
			this.requestAutoStart();
		}
	}

	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.panel = undefined;
		this.onDispose();

		this.clearHealthTimer();
		const disposables = this.disposables.splice(0);
		for (const disposable of disposables) {
			disposable.dispose();
		}

		if (this.state.streaming) {
			await this.stopStream();
		}
	}

	public async handleViewportFrame(payload: ViewportFramePayload): Promise<void> {
		if (typeof payload.sessionId !== 'string' || payload.sessionId !== this.sessionId) {
			return;
		}
		if (typeof payload.data !== 'string' && typeof payload.path !== 'string') {
			return;
		}

		try {
			const dataUri = typeof payload.data === 'string'
				? normalizeFrameDataUri(payload.data)
				: `data:image/jpeg;base64,${(await fs.readFile(payload.path as string)).toString('base64')}`;
			this.state.frame = {
				dataUri,
					sequence: toNumber(payload.sequence, 0),
					width: toNumber(payload.width, 0),
					height: toNumber(payload.height, 0),
					flippedVertical: payload.flippedVertical === true,
					timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString()
				};
			this.state.streaming = true;
			this.setStatus(`Live frame ${this.state.frame.sequence}`);
		} catch (error: unknown) {
			this.setStatus(`Frame unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	public handleConnectionState(state: ConnectionState): void {
		this.state.connectionState = state;
		if (state !== ConnectionState.Connected) {
			this.sessionId = undefined;
			this.state.streaming = false;
			this.clearHealthTimer();
			this.setStatus(disconnectedStatus(this.host));
			return;
		}

		if (this.state.frame == null && this.state.streaming === false) {
			this.setStatus(connectedStatus(this.mode, this.host));
		} else {
			this.postState();
		}
	}

	public getProofState(): Record<string, unknown> {
		const frame = this.state.frame;
		return {
			mode: this.mode,
			host: this.host,
			captureMode: this.host === 'player' ? 'camera' : 'editorWindow',
			connectionState: this.state.connectionState,
			streaming: this.state.streaming,
			status: this.state.status,
			sessionId: this.sessionId ?? null,
			inputProof: this.inputProof ?? null,
			frame: frame == null ? null : {
				sequence: frame.sequence,
				width: frame.width,
					height: frame.height,
					flippedVertical: frame.flippedVertical,
					timestamp: frame.timestamp,
					dataBytes: dataUriByteLength(frame.dataUri),
					sha256: hashDataUri(frame.dataUri)
			}
		};
	}

	public async runProofInput(): Promise<ViewportInputProof> {
		const frame = this.state.frame;
		const attemptedAt = new Date().toISOString();
		if (this.ctx.connectionManager.info.state !== ConnectionState.Connected || this.state.streaming === false || this.sessionId == null || frame == null) {
			return this.recordInputProof({
				attemptedAt,
				inputType: this.mode === 'scene' ? 'sceneDrag' : 'pointerDown',
				success: false,
				layer: null,
				result: null,
				error: 'Viewport stream is not ready for input proof.'
			});
		}

		const x = Math.max(1, Math.floor(frame.width / 2));
		const y = Math.max(1, Math.floor(frame.height / 2));
		const x2 = Math.min(frame.width, x + Math.max(8, Math.floor(frame.width * 0.05)));
		const y2 = Math.min(frame.height, y + Math.max(8, Math.floor(frame.height * 0.05)));
		if (this.mode === 'scene') {
			const step = proofInputStep('sceneDrag', await this.sendViewportInputArgs({
				action: 'input',
				sessionId: this.sessionId,
				host: this.host,
				view: this.mode,
				inputType: 'sceneDrag',
				x,
				y,
				x2,
				y2,
				button: 'left'
			}));
			return this.recordInputProof({
				...step,
				attemptedAt,
				success: step.success && step.layer === 'editorWindow',
				error: step.success && step.layer === 'editorWindow' ? undefined : step.error ?? 'Scene input did not route through the Unity EditorWindow.'
			});
		}

		const down = proofInputStep('pointerDown', await this.sendViewportInputArgs({
			action: 'input',
			sessionId: this.sessionId,
			host: this.host,
			view: this.mode,
			inputType: 'pointerDown',
			x,
			y,
			button: 'left'
		}));
		const up = proofInputStep('pointerUp', await this.sendViewportInputArgs({
			action: 'input',
			sessionId: this.sessionId,
			host: this.host,
			view: this.mode,
			inputType: 'pointerUp',
			x,
			y,
			x2,
			y2,
			button: 'left'
		}));
		const success = down.success && up.success && down.layer === 'editorWindow' && up.layer === 'editorWindow';
		return this.recordInputProof({
			...down,
			attemptedAt,
			inputType: 'pointerDown+pointerUp',
			success,
			followUp: up,
			error: success ? undefined : down.error ?? up.error ?? 'Game input did not route through the Unity EditorWindow.'
		});
	}

	private async handleWebviewMessage(message: ViewportWebviewMessage | undefined | null): Promise<void> {
		if (message == null || typeof message.type !== 'string') {
			return;
		}

		switch (message.type) {
			case 'ready':
				this.postState();
				if (this.autoStartRequested) {
					this.requestAutoStart();
				}
				return;
			case 'setOption':
				this.setOption(message.name, message.value);
				return;
			case 'startStream':
				await this.startStream();
				return;
			case 'connectUnity':
				await this.ensureUnityConnected();
				return;
			case 'stopStream':
				await this.stopStream();
				return;
			case 'captureScreenshot':
				await this.captureScreenshot();
				return;
			case 'input':
				await this.sendInput(message);
				return;
		}
	}

	private async startStream(): Promise<void> {
		if (this.pendingStartStream != null) {
			await this.pendingStartStream;
			return;
		}

		const pendingStart = this.startStreamCore();
		this.pendingStartStream = pendingStart;
		try {
			await pendingStart;
		} finally {
			if (this.pendingStartStream === pendingStart) {
				this.pendingStartStream = undefined;
			}
		}
	}

	private async startStreamCore(): Promise<void> {
		if (this.sessionId != null && this.state.streaming) {
			return;
		}

		if (await this.ensureUnityConnected() === false) {
			return;
		}

		const sessionId = `${this.host}_${safeSessionSegment(this.mode)}_view_${Date.now()}`;
		this.sessionId = sessionId;
		this.state.streaming = true;
		this.state.frame = undefined;
		this.inputProof = undefined;
		this.setStatus(`Starting ${this.title}`);

		const response = await this.ctx.commandSender.request('mcpToolCall', {
			toolName: 'viewport_stream',
			args: {
				action: 'start',
				sessionId,
				host: this.host,
				view: this.mode,
				captureMode: this.host === 'player' ? 'camera' : 'editorWindow',
				width: resolutionWidth(this.state.options.aspect),
				height: resolutionHeight(this.state.options.aspect),
				fps: this.state.options.fps,
				quality: this.state.options.quality,
				sceneTool: this.state.options.sceneTool,
				sceneSpace: this.state.options.sceneSpace,
				gizmos: this.state.options.gizmos,
				twoD: this.state.options.twoD
			}
		});

		const parsed = parseToolJson(response?.result);
		if (parsed == null || parsed.success === false) {
			this.state.streaming = false;
			this.setStatus(toolErrorMessage(parsed, 'Stream start failed'));
			return;
		}

		this.setStatus(this.host === 'player' ? 'Waiting for player viewport frames' : 'Waiting for real Unity editor-window frames');
		this.scheduleHealthCheck();
	}

	private async stopStream(): Promise<void> {
		this.state.streaming = false;
		this.inputProof = undefined;
		this.clearHealthTimer();
		const sessionId = this.sessionId;
		this.sessionId = undefined;
		if (this.ctx.connectionManager.info.state === ConnectionState.Connected) {
			await this.ctx.commandSender.request('mcpToolCall', {
				toolName: 'viewport_stream',
				args: { action: 'stop', sessionId: sessionId ?? '', host: this.host, view: this.mode }
			});
		}
		this.setStatus('Stream stopped');
	}

	private async captureScreenshot(): Promise<void> {
		if (this.host === 'player') {
			this.setStatus('Player screenshots use the live viewport stream; the screenshot tool is editor-only.');
			return;
		}

		if (await this.ensureUnityConnected() === false) {
			return;
		}

		const response = await this.ctx.commandSender.request('mcpToolCall', { toolName: 'screenshot', args: { view: this.mode } });
		const parsed = parseToolJson(response?.result);
		const path = typeof parsed?.path === 'string' ? parsed.path : typeof response?.result === 'string' ? response.result : '';
		this.setStatus(path ? `Screenshot saved: ${path}` : 'Screenshot requested');
	}

	private async ensureUnityConnected(): Promise<boolean> {
		this.state.connectionState = this.ctx.connectionManager.info.state;
		if (this.ctx.connectionManager.info.state === ConnectionState.Connected) {
			return true;
		}

		if (this.host === 'player') {
			this.setStatus('Attaching to running Viewport Service player');
			const port = await this.ctx.connectionManager.connect();
			const nextState = this.ctx.connectionManager.info.state as ConnectionState;
			this.state.connectionState = nextState;
			if (port != null && nextState === ConnectionState.Connected) {
				this.setStatus(`Viewport Service connected. Start ${this.title} to render.`);
				return true;
			}

			this.setStatus('Viewport Service still disconnected. Start the player service, then Connect.');
			return false;
		}

		this.setStatus('Launching or attaching hidden Unity Editor');
		await vscode.commands.executeCommand('unity-cursor-toolkit.startConnection');
		const nextState = this.ctx.connectionManager.info.state as ConnectionState;
		this.state.connectionState = nextState;
		if (nextState === ConnectionState.Connected) {
			this.setStatus(`Unity connected. Start ${this.title} to render.`);
			return true;
		}

		this.setStatus('Unity still disconnected. Check the Unity editor launch log from the attach notification.');
		return false;
	}

	private requestAutoStart(): void {
		this.autoStartRequested = true;
		if (this.sessionId != null || this.state.streaming) {
			return;
		}
		if (this.pendingStartStream != null) {
			return;
		}

		this.setStatus(`Preparing ${this.title} stream`);
		setTimeout(() => {
			void this.startStream();
		}, 0);
	}

	private scheduleHealthCheck(): void {
		this.clearHealthTimer();
		this.healthTimer = setTimeout(() => {
			void this.checkStreamHealth();
		}, 2500);
	}

	private clearHealthTimer(): void {
		if (this.healthTimer) {
			clearTimeout(this.healthTimer);
			this.healthTimer = undefined;
		}
	}

	private async checkStreamHealth(): Promise<void> {
		this.healthTimer = undefined;
		if (this.state.frame != null || this.ctx.connectionManager.info.state !== ConnectionState.Connected) {
			return;
		}

		const response = await this.ctx.commandSender.request('mcpToolCall', {
			toolName: 'viewport_stream',
			args: { action: 'status', sessionId: this.sessionId ?? '', host: this.host, view: this.mode }
		});
		const parsed = parseToolJson(response?.result);
		const sessionValue = parsed == null ? undefined : parsed.session;
		const session = isRecord(sessionValue) ? sessionValue : undefined;
		const lastError = typeof session?.lastError === 'string' ? session.lastError : '';
		this.setStatus(lastError.length > 0 ? lastError : `${this.host === 'player' ? 'Viewport Service' : 'Unity'} stream is running, but no frame has arrived yet.`);
	}

	private async sendInput(message: ViewportWebviewMessage): Promise<void> {
		if (this.ctx.connectionManager.info.state !== ConnectionState.Connected || this.state.streaming === false) {
			return;
		}

		const response = await this.sendViewportInputArgs(this.createViewportInputArgs(message));
		const parsed = parseToolJson(response?.result);
		if (parsed == null || parsed.success === false) {
			this.setStatus(toolErrorMessage(parsed, 'Viewport input failed'));
		}
	}

	private async sendViewportInputArgs(args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		return this.ctx.commandSender.request('mcpToolCall', {
			toolName: 'viewport_stream',
			args
		});
	}

	private createViewportInputArgs(message: ViewportWebviewMessage): Record<string, unknown> {
		return {
			action: 'input',
			sessionId: this.sessionId ?? '',
			host: this.host,
			view: this.mode,
			inputType: typeof message.inputType === 'string' ? message.inputType : defaultInputType(this.mode),
			x: toNumber(message.x, 0),
			y: toNumber(message.y, 0),
			x2: toNumber(message.x2, 0),
			y2: toNumber(message.y2, 0),
			dx: toNumber(message.dx, 0),
			dy: toNumber(message.dy, 0),
			wheelDelta: toNumber(message.wheelDelta, 0),
			button: typeof message.button === 'string' ? message.button : undefined,
			key: typeof message.key === 'string' ? message.key : undefined,
			text: typeof message.text === 'string' ? message.text : undefined,
			cursorLocked: this.mode === 'game' ? this.state.options.gameCursorLock : undefined,
			sceneTool: this.mode === 'scene' ? this.state.options.sceneTool : undefined,
			sceneSpace: this.mode === 'scene' ? this.state.options.sceneSpace : undefined
		};
	}

	private recordInputProof(proof: ViewportInputProof): ViewportInputProof {
		this.inputProof = proof;
		return proof;
	}

	private setOption(name: unknown, value: unknown): void {
		if (typeof name !== 'string') {
			return;
		}

		const options = this.state.options;
		switch (name) {
			case 'aspect':
				this.state.options = { ...options, aspect: typeof value === 'string' ? value : options.aspect };
				break;
			case 'fps':
				this.state.options = { ...options, fps: Math.max(1, Math.min(60, toNumber(value, options.fps))) };
				break;
			case 'quality':
				this.state.options = { ...options, quality: Math.max(1, Math.min(100, toNumber(value, options.quality))) };
				break;
			case 'gizmos':
				this.state.options = { ...options, gizmos: value === true };
				break;
			case 'twoD':
				this.state.options = { ...options, twoD: value === true };
				break;
			case 'sceneTool':
				this.state.options = { ...options, sceneTool: typeof value === 'string' ? value : options.sceneTool };
				break;
			case 'sceneSpace':
				this.state.options = { ...options, sceneSpace: typeof value === 'string' ? value : options.sceneSpace };
				break;
			case 'gameCursorLock':
				this.state.options = { ...options, gameCursorLock: value === true };
				break;
			default:
				return;
		}
		this.postState();
	}

	private setStatus(status: string): void {
		this.state.status = status;
		this.postState();
	}

	private postState(): void {
		void this.panel?.webview.postMessage({ type: 'state', state: this.state });
	}

	private get title(): string {
		return titleForMode(this.mode, this.host);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = createNonce();
		const csp = [
			"default-src 'none'",
			"img-src data:",
			`style-src ${webview.cspSource} 'nonce-${nonce}'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`
		].join('; ');

		const isScene = this.mode === 'scene';
		const connectTitle = this.host === 'player'
			? 'Attach to a running Viewport Service player bridge'
			: 'Launch or attach to the hidden Unity Editor bridge';
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Unity ${this.title}</title>
	<style nonce="${nonce}">
		:root { color-scheme: var(--vscode-color-scheme); }
		* { box-sizing: border-box; letter-spacing: 0; }
		body {
			margin: 0;
			height: 100vh;
			overflow: hidden;
			font-family: var(--vscode-font-family);
			font-size: 12px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
		}
		button, select, input { font: inherit; color: var(--vscode-foreground); }
		button {
			height: 26px;
			min-width: 26px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border-radius: 3px;
			padding: 0 9px;
			cursor: pointer;
		}
		button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		button.active { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
		select, input[type="number"] {
			height: 26px;
			border: 1px solid var(--vscode-dropdown-border, transparent);
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border-radius: 3px;
			padding: 0 7px;
		}
		input[type="checkbox"] { margin: 0; }
		.shell {
			height: 100vh;
			display: grid;
			grid-template-rows: 36px 1fr 26px;
			background: var(--vscode-editor-background);
		}
		.topbar {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 5px 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
			overflow-x: auto;
			overflow-y: hidden;
		}
		.control-group { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
		.control-group label { color: var(--vscode-descriptionForeground); }
		.viewport {
			min-width: 0;
			min-height: 0;
			position: relative;
			display: grid;
			place-items: stretch;
			background: ${isScene ? '#111820' : '#05070b'};
		}
		.viewport-stage {
			position: relative;
			margin: 10px;
			display: grid;
			place-items: center;
			overflow: hidden;
			border: 1px solid var(--vscode-panel-border);
			background:
				linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
				linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px),
				${isScene ? '#10151b' : '#080b10'};
			background-size: 32px 32px;
			user-select: none;
		}
		.viewport-stage.locked { cursor: none; }
		.viewport-img {
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
			display: block;
		}
		.placeholder {
			width: min(74%, 720px);
			aspect-ratio: 16 / 9;
			display: grid;
			place-items: center;
			border: 1px solid rgba(255,255,255,0.12);
			background: linear-gradient(135deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
			color: var(--vscode-descriptionForeground);
		}
		.statusbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0 8px;
			border-top: 1px solid var(--vscode-panel-border);
			background: var(--vscode-statusBar-background);
			color: var(--vscode-statusBar-foreground);
			overflow: hidden;
		}
		.statusbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	</style>
</head>
<body>
	<div class="shell">
		<header class="topbar">
			<button id="connect" title="${connectTitle}">Connect</button>
			<button id="start" class="primary" title="Start ${this.title} stream">Start</button>
			<button id="stop" title="Stop ${this.title} stream">Stop</button>
			<button id="shot" title="Capture screenshot">Shot</button>
			<span class="control-group">
				<label for="aspect">Aspect</label>
				<select id="aspect">
					<option value="16:9">16:9</option>
					<option value="4:3">4:3</option>
					<option value="1:1">1:1</option>
					<option value="9:16">9:16</option>
				</select>
			</span>
			<span class="control-group">
				<label for="fps">FPS</label>
				<input id="fps" type="number" min="1" max="60" step="1">
			</span>
			<span class="control-group">
				<label for="quality">Quality</label>
				<input id="quality" type="number" min="1" max="100" step="1">
			</span>
		</header>
		<main class="viewport">
			<section id="stage" class="viewport-stage" tabindex="0">
				<div id="empty" class="placeholder">Unity disconnected</div>
				<img id="frame" class="viewport-img" alt="Unity ${this.title} frame">
			</section>
		</main>
		<footer class="statusbar">
			<span id="status">Loading</span>
			<span id="meta">Unity ${this.title}</span>
		</footer>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const mode = ${JSON.stringify(this.mode)};
		let state = null;
		let drag = null;
		const els = {
			start: document.getElementById('start'),
			connect: document.getElementById('connect'),
			stop: document.getElementById('stop'),
			shot: document.getElementById('shot'),
			stage: document.getElementById('stage'),
			empty: document.getElementById('empty'),
			frame: document.getElementById('frame'),
			status: document.getElementById('status'),
			meta: document.getElementById('meta'),
			aspect: document.getElementById('aspect'),
			fps: document.getElementById('fps'),
			quality: document.getElementById('quality'),
		};

		window.addEventListener('message', event => {
			if (!event.data || event.data.type !== 'state') return;
			state = event.data.state;
			render();
		});

		els.connect.addEventListener('click', () => post({ type: 'connectUnity' }));
		els.start.addEventListener('click', () => post({ type: 'startStream' }));
		els.stop.addEventListener('click', () => post({ type: 'stopStream' }));
		els.shot.addEventListener('click', () => post({ type: 'captureScreenshot' }));
		els.aspect.addEventListener('change', () => postOption('aspect', els.aspect.value));
		els.fps.addEventListener('change', () => postOption('fps', Number(els.fps.value)));
		els.quality.addEventListener('change', () => postOption('quality', Number(els.quality.value)));
		els.stage.addEventListener('pointerdown', event => {
			els.stage.focus();
			if (mode === 'game' && state && state.streaming && document.pointerLockElement !== els.stage) {
				const lock = els.stage.requestPointerLock?.();
				if (lock && typeof lock.catch === 'function') lock.catch(() => {});
			}
			drag = point(event);
			els.stage.setPointerCapture?.(event.pointerId);
			postPointer('pointerDown', event);
		});
		els.stage.addEventListener('pointerup', event => {
			const start = drag || point(event);
			drag = null;
			post({
				type: 'input',
				inputType: mode === 'scene' ? 'sceneDrag' : 'pointerUp',
				x: start.x,
				y: start.y,
				x2: point(event).x,
				y2: point(event).y,
				button: buttonName(event.button)
			});
		});
		els.stage.addEventListener('pointermove', event => {
			if (document.pointerLockElement === els.stage) {
				post({ type: 'input', inputType: 'mouseDelta', dx: event.movementX || 0, dy: event.movementY || 0 });
				return;
			}
			if (drag) {
				post({
					type: 'input',
					inputType: mode === 'scene' ? 'sceneDrag' : 'pointerMove',
					x: drag.x,
					y: drag.y,
					x2: point(event).x,
					y2: point(event).y,
					button: buttonName(event.button)
				});
			}
		});
		els.stage.addEventListener('wheel', event => {
			post({ type: 'input', inputType: mode === 'scene' ? 'sceneZoom' : 'wheel', wheelDelta: event.deltaY });
			event.preventDefault();
		}, { passive: false });
		els.stage.addEventListener('keydown', event => {
			post({ type: 'input', inputType: 'key', key: event.key });
			if (mode === 'game' && event.key === 'Escape' && document.pointerLockElement === els.stage) {
				document.exitPointerLock?.();
			}
		});
		document.addEventListener('pointerlockchange', () => {
			if (mode !== 'game') return;
			const locked = document.pointerLockElement === els.stage;
			postOption('gameCursorLock', locked);
		});

		function post(message) {
			vscode.postMessage(message);
		}
		function postOption(name, value) {
			post({ type: 'setOption', name, value });
		}
		function render() {
			if (!state) return;
			els.status.textContent = state.status || '';
			els.meta.textContent = state.frame ? state.frame.width + 'x' + state.frame.height + ' #' + state.frame.sequence : 'Unity ${this.title}';
			els.empty.textContent = state.status || 'No Unity frame';
			els.aspect.value = state.options.aspect;
			els.fps.value = String(state.options.fps);
			els.quality.value = String(state.options.quality);
			els.stop.disabled = !state.streaming;
			els.stage.classList.toggle('locked', !!state.options.gameCursorLock);
			if (state.frame && state.frame.dataUri) {
				els.frame.src = state.frame.dataUri;
				els.frame.style.display = 'block';
				els.empty.style.display = 'none';
			} else {
				els.frame.removeAttribute('src');
				els.frame.style.display = 'none';
				els.empty.style.display = 'grid';
			}
		}
		function point(event) {
			const hasFrame = state && state.frame && els.frame.style.display !== 'none';
			const rect = hasFrame ? els.frame.getBoundingClientRect() : els.stage.getBoundingClientRect();
			if (hasFrame && rect.width > 0 && rect.height > 0) {
				return {
					x: clamp(Math.round((event.clientX - rect.left) * state.frame.width / rect.width), 0, state.frame.width),
					y: clamp(Math.round((event.clientY - rect.top) * state.frame.height / rect.height), 0, state.frame.height)
				};
			}
			return { x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) };
		}
		function clamp(value, min, max) {
			return Math.max(min, Math.min(max, value));
		}
		function postPointer(inputType, event) {
			const p = point(event);
			post({ type: 'input', inputType, x: p.x, y: p.y, button: buttonName(event.button) });
		}
		function buttonName(button) {
			return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
		}
		post({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

class ViewportStatusBarContributor implements IStatusBarContributor {
	public readonly group = 'Viewport';

	public getActions(): QuickAccessAction[] {
		return [
			{ label: '$(layout-panel) Open Scene View', command: 'unity-cursor-toolkit.viewport.openSceneView' },
			{ label: '$(game) Open Game View', command: 'unity-cursor-toolkit.viewport.openGameView' },
			{ label: '$(play) Open Player Scene View', command: 'unity-cursor-toolkit.viewport.openPlayerSceneView' },
			{ label: '$(run) Open Player Game View', command: 'unity-cursor-toolkit.viewport.openPlayerGameView' },
			{ label: '$(inspect) Open Inspector', command: 'unity-cursor-toolkit.viewport.openInspector' },
			{ label: '$(package) Open Package Manager', command: 'unity-cursor-toolkit.viewport.openPackageManager' },
			{ label: '$(window) Open Custom EditorWindow', command: 'unity-cursor-toolkit.viewport.openCustomWindow' },
			{ label: '$(list-tree) Focus Hierarchy', command: 'unity-cursor-toolkit.hierarchy.focus' }
		];
	}
}

function createInitialPanelState(mode: ViewMode, host: ViewHost, connectionState: ConnectionState): ViewportPanelState {
	return {
		mode,
		host,
		connectionState,
		streaming: false,
		status: connectionState === ConnectionState.Connected ? connectedStatus(mode, host) : disconnectedStatus(host),
		options: {
			aspect: '16:9',
			fps: mode === 'game' ? 30 : mode === 'scene' ? 12 : 2,
			quality: 72,
			gizmos: true,
			twoD: false,
			sceneTool: 'view',
			sceneSpace: 'global',
			gameCursorLock: false
		}
	};
}

function titleForMode(mode: ViewMode, host: ViewHost = 'editor'): string {
	if (host === 'player') {
		switch (mode) {
			case 'game':
				return 'Player Game View';
			case 'scene':
				return 'Player Scene View';
			default:
				return 'Player Viewport';
		}
	}

	switch (mode) {
		case 'game':
			return 'Game View';
		case 'inspector':
			return 'Inspector';
		case 'packageManager':
			return 'Package Manager';
		case 'scene':
			return 'Scene View';
		default:
			if (mode.startsWith('window:')) {
				return shortWindowTitle(mode.substring('window:'.length));
			}
			return 'Editor Window';
	}
}

function connectedStatus(mode: ViewMode, host: ViewHost): string {
	if (host === 'player') {
		return `Viewport Service connected. Start ${titleForMode(mode, host)} to render the player camera stream.`;
	}

	return `Unity connected. Start ${titleForMode(mode, host)} to render the real Unity editor window.`;
}

function disconnectedStatus(host: ViewHost): string {
	return host === 'player'
		? 'Viewport Service disconnected. Start the player service, then Connect.'
		: 'Unity disconnected. Connect will launch or attach the hidden Unity Editor.';
}

function panelTypeForMode(mode: ViewMode, host: ViewHost): string {
	const prefix = host === 'player' ? 'unityPlayer' : 'unity';
	return `${prefix}${titleForMode(mode, host).replace(/[^A-Za-z0-9]+/g, '') || 'EditorWindow'}`;
}

function safeSessionSegment(mode: ViewMode): string {
	return mode.replace(/[^A-Za-z0-9]+/g, '_') || 'viewport';
}

function shortWindowTitle(typeName: string): string {
	const withoutAssembly = typeName.split(',')[0]?.trim() ?? typeName;
	const parts = withoutAssembly.split('.').filter((part) => part.length > 0);
	return parts.length === 0 ? 'Editor Window' : parts[parts.length - 1];
}

function parseToolJson(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

function toolErrorMessage(value: Record<string, unknown> | null, fallback: string): string {
	if (value == null) {
		return fallback;
	}

	if (typeof value.error === 'string' && value.error.length > 0) {
		return value.error;
	}

	if (typeof value.message === 'string' && value.message.length > 0) {
		return value.message;
	}

	if (isRecord(value.result)) {
		const nested = toolErrorMessage(value.result, '');
		if (nested.length > 0) {
			return nested;
		}
	}

	return fallback;
}

function normalizeFrameDataUri(data: string): string {
	return data.startsWith('data:image/') ? data : `data:image/jpeg;base64,${data}`;
}

function parseHierarchyRoots(value: Record<string, unknown> | null): HierarchyNode[] {
	const roots = value?.roots as unknown;
	if (!Array.isArray(roots)) {
		return [];
	}
	return (roots as unknown[]).map(parseHierarchyNode).filter((node): node is HierarchyNode => node != null);
}

function parseHierarchyNode(value: unknown): HierarchyNode | null {
	if (!isRecord(value)) {
		return null;
	}

	const record = value as Record<string, unknown>;
	const rawChildren = record.children;
	const children = Array.isArray(rawChildren)
		? (rawChildren as unknown[]).map(parseHierarchyNode).filter((node): node is HierarchyNode => node != null)
		: [];
	return {
		name: typeof record.name === 'string' ? record.name : 'GameObject',
		instanceId: typeof record.instanceId === 'number' ? record.instanceId : undefined,
		children
	};
}

function resolutionWidth(aspect: string): number {
	switch (aspect) {
		case '4:3':
			return 1024;
		case '1:1':
			return 900;
		case '9:16':
			return 720;
		default:
			return 1280;
	}
}

function resolutionHeight(aspect: string): number {
	switch (aspect) {
		case '4:3':
			return 768;
		case '1:1':
			return 900;
		case '9:16':
			return 1280;
		default:
			return 720;
	}
}

function defaultInputType(mode: ViewMode): string {
	return mode === 'scene' ? 'sceneTap' : 'tap';
}

function toNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isProofFrameReady(value: Record<string, unknown> | undefined): boolean {
	if (value == null) {
		return false;
	}
	const frame = isRecord(value?.frame) ? value.frame : undefined;
	return value.host === 'editor'
		&& value.captureMode === 'editorWindow'
		&& value.streaming === true
		&& typeof value.status === 'string'
		&& value.status.startsWith('Live frame')
		&& typeof frame?.sha256 === 'string'
		&& /^[a-f0-9]{64}$/.test(frame.sha256)
		&& toNumber(frame.width, 0) > 0
		&& toNumber(frame.height, 0) > 0
		&& toNumber(frame.sequence, 0) > 0;
}

function isProofInputReady(value: Record<string, unknown> | undefined): boolean {
	if (value == null) {
		return false;
	}
	const inputProof = isRecord(value.inputProof) ? value.inputProof : undefined;
	return inputProof?.success === true && inputProof.layer === 'editorWindow';
}

function proofInputStep(inputType: string, response: Record<string, unknown> | null): ViewportInputProofStep {
	const parsed = parseToolJson(response?.result);
	const success = parsed?.success === true;
	const layer = typeof parsed?.layer === 'string' ? parsed.layer : null;
	const result = parsed?.result ?? parsed ?? response ?? null;
	return {
		inputType,
		success,
		layer,
		result,
		...(success ? {} : { error: toolErrorMessage(parsed, 'Viewport input failed') })
	};
}

function hashDataUri(dataUri: string): string {
	return createHash('sha256').update(dataUriBytes(dataUri)).digest('hex');
}

function dataUriByteLength(dataUri: string): number {
	return dataUriBytes(dataUri).length;
}

function dataUriBytes(dataUri: string): Buffer {
	const base64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
	return Buffer.from(base64, 'base64');
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value != null && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function dirname(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const index = normalized.lastIndexOf('/');
	return index >= 0 ? filePath.slice(0, index) : '.';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && Array.isArray(value) === false;
}

function createNonce(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
		value += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return value;
}
