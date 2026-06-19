/**
 * Viewport stream MCP tools backed by Unity frame notifications and local MJPEG.
 */

import * as fs from 'fs/promises';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { ICommandSender, IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import { getToolAnnotations, isDryRun, withDryRunProperty } from './toolMetadata';
import type { StandaloneUnityMessage } from './standaloneConnection';
import {
	createEditorWindowRenderBackend,
	createLocalEditorComputeBackend,
	createPlayerCameraRenderBackend,
	createUnityEditorShellSurface,
	createUnityHostSession,
	createUnityMcpInputRouter,
	type UnityHostSessionSnapshot
} from '../remote-shell/session';

const DEFAULT_BOUNDARY = 'unity-cursor-toolkit-frame';

interface ViewportFrame {
	readonly sessionId: string;
	readonly path?: string;
	readonly data?: string;
	readonly sequence: number;
	readonly width: number;
	readonly height: number;
	readonly timestamp: string;
}

interface ViewportSession {
	readonly sessionId: string;
	readonly startedAt: string;
	readonly host: string;
	readonly fps: number;
	readonly width: number;
	readonly height: number;
	readonly quality: number;
	readonly hostSession: UnityHostSessionSnapshot;
	streamUrl: string;
	latestFrame?: ViewportFrame;
	latestBytes?: Buffer;
}

export class ViewportStreamMcpTools implements IToolProvider {

	public readonly toolGroupName = 'viewport';

	private server: http.Server | undefined;
	private clients = new Set<http.ServerResponse>();
	private port: number | null = null;
	private session: ViewportSession | undefined;

	constructor(private readonly commandSender: ICommandSender) {}

	public getTools(): ToolDefinition[] {
		return [{
			name: 'viewport_stream',
			title: 'Viewport Stream',
			description: 'Start, stop, inspect, or send input to a Unity viewport MJPEG stream.',
			inputSchema: {
				type: 'object',
				properties: withDryRunProperty({
					action: { type: 'string', enum: ['start', 'stop', 'status', 'input'], description: 'Defaults to status.' },
					host: { type: 'string', enum: ['editor', 'player', 'auto'], description: 'Capture host. Defaults to auto.' },
					width: { type: 'number', description: 'Requested capture width. Defaults to 640.' },
					height: { type: 'number', description: 'Requested capture height. Defaults to 360.' },
					fps: { type: 'number', description: 'Requested frame rate. Defaults to 10.' },
					quality: { type: 'number', description: 'JPEG quality 1-100. Defaults to 70.' },
					view: { type: 'string', description: 'Unity viewport surface. Defaults to scene. Built-in editor-window targets: scene, game, inspector, packageManager. Custom EditorWindows may use window:<full-type-name>.' },
					captureMode: { type: 'string', enum: ['editorWindow', 'camera', 'auto'], description: 'editorWindow captures real Unity editor UI; camera keeps the legacy render fallback.' },
					port: { type: 'number', description: 'Local HTTP port. Defaults to an ephemeral port.' },
					inputType: { type: 'string', enum: ['tap', 'swipe', 'pointerDown', 'pointerMove', 'pointerUp', 'sceneDrag', 'sceneZoom', 'wheel', 'mouseDelta', 'key', 'text'], description: 'Input event type for action input.' },
					x: { type: 'number' },
					y: { type: 'number' },
					x2: { type: 'number' },
					y2: { type: 'number' },
					key: { type: 'string' },
					text: { type: 'string' },
					durationMs: { type: 'number' }
				})
			},
			annotations: getToolAnnotations('viewport_stream')
		}];
	}

	public handleUnityMessage(message: StandaloneUnityMessage): void {
		if (message.command !== 'viewportFrame') {
			return;
		}

		const frame = parseFrame(message.payload);
		if (frame == null || this.session == null || frame.sessionId !== this.session.sessionId) {
			return;
		}

		void this.publishFrame(frame);
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name !== 'viewport_stream') {
			return jsonResult({ success: false, error: `Unknown tool: ${name}` }, true);
		}

		const action = getString(args, 'action', 'status');
		switch (action) {
			case 'start':
				return this.start(args);
			case 'stop':
				return this.stop(args);
			case 'status':
				return jsonResult({ success: true, status: this.getStatus() });
			case 'input':
				return this.input(args);
			default:
				return jsonResult({ success: false, error: `Unknown viewport_stream action: ${action}` }, true);
		}
	}

	public async dispose(): Promise<void> {
		await this.closeServer();
	}

	private async start(args: Record<string, unknown>): Promise<ToolResult> {
		const sessionId = `viewport_${Date.now()}`;
		const width = getPositiveNumber(args, 'width', 640);
		const height = getPositiveNumber(args, 'height', 360);
		const fps = getPositiveNumber(args, 'fps', 10);
		const quality = Math.min(100, Math.max(1, getPositiveNumber(args, 'quality', 70)));
		const host = getString(args, 'host', 'auto');
		const view = getString(args, 'view', 'scene');
		const captureMode = getString(args, 'captureMode', host === 'player' ? 'camera' : 'editorWindow');
		const requestedPort = getPort(args, 'port', 0);

		if (isDryRun(args)) {
			const streamUrl = requestedPort > 0 ? `http://127.0.0.1:${requestedPort}/viewport.mjpg` : undefined;
			return jsonResult({
				success: true,
				dryRun: true,
				command: 'mcpToolCall',
				toolName: 'viewport_stream',
				args: { action: 'start', sessionId, width, height, fps, quality, host, view, captureMode },
				hostSession: buildViewportHostSessionSnapshot({ sessionId, host, view, captureMode, width, height, fps, quality, streamUrl }),
				localServer: { host: '127.0.0.1', port: requestedPort }
			});
		}

		await this.ensureServer(requestedPort);
		const streamUrl = `http://127.0.0.1:${this.port}/viewport.mjpg`;
		this.session = {
			sessionId,
			startedAt: new Date().toISOString(),
			host,
			fps,
			width,
			height,
			quality,
			streamUrl,
			hostSession: buildViewportHostSessionSnapshot({ sessionId, host, view, captureMode, width, height, fps, quality, streamUrl })
		};

		const unity = await this.commandSender.request('mcpToolCall', {
			toolName: 'viewport_stream',
			args: { action: 'start', sessionId, width, height, fps, quality, host, view, captureMode }
		});

		if (unity == null || isUnityFailure(unity.result)) {
			await this.closeServer();
			return jsonResult({
				success: false,
				error: unity == null ? 'Unity did not respond to viewport_stream start.' : 'Unity rejected viewport_stream start.',
				unity: unity?.result
			}, true);
		}

		return jsonResult({
			success: true,
			status: this.getStatus(),
			unity: unity.result
		});
	}

	private async stop(args: Record<string, unknown>): Promise<ToolResult> {
		if (isDryRun(args)) {
			return jsonResult({ success: true, dryRun: true, command: 'mcpToolCall', toolName: 'viewport_stream', args: { action: 'stop' } });
		}

		const previous = this.getStatus();
		await this.commandSender.request('mcpToolCall', { toolName: 'viewport_stream', args: { action: 'stop' } });
		await this.closeServer();
		return jsonResult({ success: true, stopped: previous });
	}

	private async input(args: Record<string, unknown>): Promise<ToolResult> {
		const unityArgs: Record<string, unknown> = { ...args, action: 'input', sessionId: this.session?.sessionId ?? getString(args, 'sessionId', '') };
		delete unityArgs.dryRun;

		if (isDryRun(args)) {
			return jsonResult({ success: true, dryRun: true, command: 'mcpToolCall', toolName: 'viewport_stream', args: unityArgs });
		}

		const unity = await this.commandSender.request('mcpToolCall', { toolName: 'viewport_stream', args: unityArgs });
		if (unity == null || isUnityFailure(unity.result)) {
			return jsonResult({
				success: false,
				error: unity == null ? 'Unity did not respond to viewport_stream input.' : 'Unity rejected viewport_stream input.',
				unity: unity?.result
			}, true);
		}

		return jsonResult({ success: true, unity: unity.result });
	}

	private async ensureServer(requestedPort: number): Promise<void> {
		if (this.server) {
			return;
		}

		this.server = http.createServer((request, response) => {
			void this.handleHttpRequest(request, response);
		});

		await new Promise<void>((resolve, reject) => {
			this.server?.once('error', reject);
			this.server?.listen(requestedPort, '127.0.0.1', () => {
				this.server?.removeListener('error', reject);
				const address = this.server?.address() as AddressInfo | null;
				this.port = address?.port ?? requestedPort;
				resolve();
			});
		});
	}

	private async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const url = request.url ?? '/';
		if (url === '/status.json') {
			writeJson(response, { success: true, status: this.getStatus() });
			return;
		}

		if (url === '/latest.jpg') {
			if (this.session?.latestBytes == null) {
				response.writeHead(404);
				response.end('No frame available.');
				return;
			}
			response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
			response.end(this.session.latestBytes);
			return;
		}

		if (url !== '/viewport.mjpg') {
			response.writeHead(200, { 'Content-Type': 'text/plain' });
			response.end('Unity Cursor Toolkit viewport stream. Use /viewport.mjpg, /latest.jpg, or /status.json.');
			return;
		}

		response.writeHead(200, {
			'Content-Type': `multipart/x-mixed-replace; boundary=${DEFAULT_BOUNDARY}`,
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Connection': 'close',
			'Pragma': 'no-cache'
		});
		this.clients.add(response);
		request.on('close', () => this.clients.delete(response));
		if (this.session?.latestBytes) {
			writeMjpegFrame(response, this.session.latestBytes);
		}
	}

	private async publishFrame(frame: ViewportFrame): Promise<void> {
		if (this.session == null) {
			return;
		}

		try {
			const bytes = frame.data != null ? decodeFrameData(frame.data) : await fs.readFile(frame.path ?? '');
			this.session.latestFrame = frame;
			this.session.latestBytes = bytes;
			for (const client of this.clients) {
				writeMjpegFrame(client, bytes);
			}
		} catch {
			// Dropped frames are expected when Unity rotates temp files quickly.
		}
	}

	private async closeServer(): Promise<void> {
		for (const client of this.clients) {
			client.end();
		}
		this.clients.clear();

		const server = this.server;
		this.server = undefined;
		this.port = null;
		this.session = undefined;

		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private getStatus(): Record<string, unknown> {
		return {
			running: this.server != null && this.session != null,
			port: this.port,
			streamUrl: this.session?.streamUrl,
			sessionId: this.session?.sessionId,
			startedAt: this.session?.startedAt,
			host: this.session?.host,
			width: this.session?.width,
			height: this.session?.height,
			fps: this.session?.fps,
			quality: this.session?.quality,
			hostSession: this.session?.hostSession,
			clients: this.clients.size,
			lastFrame: this.session?.latestFrame
		};
	}
}

export function buildViewportHostSessionSnapshot(options: {
	readonly sessionId: string;
	readonly host: string;
	readonly view: string;
	readonly captureMode: string;
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly quality: number;
	readonly streamUrl?: string;
}): UnityHostSessionSnapshot {
	const usePlayerCamera = options.host === 'player' || options.captureMode === 'camera';
	return createUnityHostSession({
		sessionId: options.sessionId,
		local: {
			kind: 'localUnityEditor',
			label: 'Unity Editor bridge',
			address: '127.0.0.1'
		},
		remote: usePlayerCamera ? {
			kind: 'remoteUnityPlayer',
			label: 'Unity player capture target'
		} : undefined,
		surface: createUnityEditorShellSurface(options.view, options.streamUrl),
		render: usePlayerCamera
			? createPlayerCameraRenderBackend({
				width: options.width,
				height: options.height,
				fps: options.fps,
				quality: options.quality,
				streamUrl: options.streamUrl
			})
			: createEditorWindowRenderBackend({
				width: options.width,
				height: options.height,
				fps: options.fps,
				quality: options.quality,
				view: options.view,
				streamUrl: options.streamUrl,
				captureMode: options.captureMode
			}),
		compute: createLocalEditorComputeBackend(),
		input: createUnityMcpInputRouter('viewport_stream')
	}).snapshot();
}

function parseFrame(payload: Record<string, unknown>): ViewportFrame | null {
	const sessionId = getString(payload, 'sessionId', '');
	const framePath = getString(payload, 'path', '');
	const data = getString(payload, 'data', '');
	if (sessionId.length === 0 || (framePath.length === 0 && data.length === 0)) {
		return null;
	}
	return {
		sessionId,
		path: framePath.length === 0 ? undefined : framePath,
		data: data.length === 0 ? undefined : data,
		sequence: getNumber(payload, 'sequence', 0),
		width: getNumber(payload, 'width', 0),
		height: getNumber(payload, 'height', 0),
		timestamp: getString(payload, 'timestamp', new Date().toISOString())
	};
}

function decodeFrameData(data: string): Buffer {
	const marker = 'base64,';
	const index = data.indexOf(marker);
	return Buffer.from(index >= 0 ? data.slice(index + marker.length) : data, 'base64');
}

function writeMjpegFrame(response: http.ServerResponse, bytes: Buffer): void {
	response.write(`--${DEFAULT_BOUNDARY}\r\n`);
	response.write('Content-Type: image/jpeg\r\n');
	response.write(`Content-Length: ${bytes.length}\r\n\r\n`);
	response.write(bytes);
	response.write('\r\n');
}

function writeJson(response: http.ServerResponse, payload: Record<string, unknown>): void {
	response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(payload, null, 2));
}

function isUnityFailure(result: unknown): boolean {
	return typeof result === 'object'
		&& result != null
		&& (result as { success?: unknown }).success === false;
}

function getString(args: Record<string, unknown>, key: string, fallback: string): string {
	const value = args[key];
	return typeof value === 'string' ? value : fallback;
}

function getNumber(args: Record<string, unknown>, key: string, fallback: number): number {
	const value = args[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getPositiveNumber(args: Record<string, unknown>, key: string, fallback: number): number {
	const value = getNumber(args, key, fallback);
	return value > 0 ? Math.floor(value) : fallback;
}

function getPort(args: Record<string, unknown>, key: string, fallback: number): number {
	const value = getNumber(args, key, fallback);
	return Number.isInteger(value) && value >= 0 && value < 65536 ? value : fallback;
}

function jsonResult(payload: Record<string, unknown>, isError = false): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		isError: isError || payload.success === false || false
	};
}
