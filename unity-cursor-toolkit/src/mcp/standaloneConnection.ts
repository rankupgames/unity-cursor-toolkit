/**
 * Standalone Unity TCP bridge for the MCP stdio server.
 *
 * This intentionally avoids importing VS Code APIs so `out/mcp/server.js`
 * can run as a plain Node process from any MCP client.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as net from 'net';
import type { ICommandSender } from '../core/interfaces';

const DEFAULT_PORTS = [55500, 55501, 55502, 55503, 55504] as const;
const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
	resolve: (value: Record<string, unknown> | null) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface StandaloneUnityMessage {
	readonly command: string;
	readonly payload: Record<string, unknown>;
}

export type StandaloneUnityMessageHandler = (message: StandaloneUnityMessage) => void;

export class StandaloneUnityConnection implements ICommandSender {

	private readonly ports: readonly number[];
	private readonly messageHandlers: StandaloneUnityMessageHandler[] = [];
	private pendingRequests = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private socket: net.Socket | undefined;
	private connectedPort: number | null = null;
	private dataBuffer = '';
	private connectPromise: Promise<boolean> | undefined;

	constructor(ports: readonly number[] = parsePorts(process.env.UNITY_CURSOR_TOOLKIT_MCP_PORTS)) {
		this.ports = ports;
	}

	public get port(): number | null {
		return this.connectedPort;
	}

	public onMessage(handler: StandaloneUnityMessageHandler): () => void {
		this.messageHandlers.push(handler);
		return () => {
			const index = this.messageHandlers.indexOf(handler);
			if (index >= 0) {
				this.messageHandlers.splice(index, 1);
			}
		};
	}

	public send(command: string, payload?: Record<string, unknown>): void {
		void this.sendAsync(command, payload);
	}

	public async request(command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const connected = await this.ensureConnected();
		if (connected === false || this.socket == null || this.socket.writable === false) {
			return null;
		}

		const requestId = `mcp_${++this.requestCounter}_${Date.now()}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				resolve(null);
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(requestId, { resolve, timer });
			this.write({ command, ...payload, _requestId: requestId });
		});
	}

	public dispose(): void {
		this.rejectPendingRequests();
		this.destroySocket();
		this.messageHandlers.length = 0;
	}

	private async sendAsync(command: string, payload?: Record<string, unknown>): Promise<void> {
		const connected = await this.ensureConnected();
		if (connected === false || this.socket == null || this.socket.writable === false) {
			return;
		}

		this.write({ command, ...payload });
	}

	private async ensureConnected(): Promise<boolean> {
		if (this.socket != null && this.socket.writable) {
			return true;
		}

		if (this.connectPromise == null) {
			this.connectPromise = this.connect();
		}

		try {
			return await this.connectPromise;
		} finally {
			this.connectPromise = undefined;
		}
	}

	private async connect(): Promise<boolean> {
		this.destroySocket();

		for (const port of this.ports) {
			const socket = await this.tryPort(port);
			if (socket) {
				this.socket = socket;
				this.connectedPort = port;
				this.attachSocketListeners(socket);
				return true;
			}
		}

		return false;
	}

	private tryPort(port: number): Promise<net.Socket | null> {
		return new Promise((resolve) => {
			const socket = new net.Socket();
			let settled = false;

			const settle = (result: net.Socket | null) => {
				if (settled) {
					return;
				}

				settled = true;
				socket.removeAllListeners();

				if (result == null) {
					socket.destroy();
				}

				resolve(result);
			};

			socket.setTimeout(CONNECT_TIMEOUT_MS);
			socket.once('connect', () => {
				socket.setTimeout(0);
				settle(socket);
			});
			socket.once('error', () => settle(null));
			socket.once('timeout', () => settle(null));
			socket.connect(port, 'localhost');
		});
	}

	private attachSocketListeners(socket: net.Socket): void {
		socket.on('data', (raw: Buffer) => {
			this.dataBuffer += raw.toString();
			const lines = this.dataBuffer.split('\n');
			this.dataBuffer = lines.pop() ?? '';

			for (const line of lines) {
				const parsed = parseJsonObject(line);
				if (parsed == null) {
					continue;
				}

				const command = typeof parsed.command === 'string' ? parsed.command : undefined;
				if (command == null) {
					continue;
				}

				const requestId = typeof parsed._requestId === 'string' ? parsed._requestId : undefined;
				if (requestId) {
					this.resolvePendingRequest(requestId, parsed);
					continue;
				}

				for (const handler of this.messageHandlers) {
					handler({ command, payload: parsed });
				}
			}
		});

		socket.on('close', () => {
			this.destroySocket();
			this.rejectPendingRequests();
		});
		socket.on('error', () => {
			this.destroySocket();
			this.rejectPendingRequests();
		});
	}

	private write(payload: Record<string, unknown>): void {
		this.socket?.write(JSON.stringify(payload) + '\n');
	}

	private resolvePendingRequest(requestId: string, payload: Record<string, unknown>): void {
		const pending = this.pendingRequests.get(requestId);
		if (pending == null) {
			return;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(requestId);
		pending.resolve(payload);
	}

	private rejectPendingRequests(): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.pendingRequests.clear();
	}

	private destroySocket(): void {
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = undefined;
		}
		this.connectedPort = null;
		this.dataBuffer = '';
	}
}

export function parsePorts(value: string | undefined): readonly number[] {
	if (value == null || value.trim().length === 0) {
		return DEFAULT_PORTS;
	}

	const ports = value
		.split(',')
		.map((part) => Number(part.trim()))
		.filter((port) => Number.isInteger(port) && port > 0 && port < 65536);

	return ports.length === 0 ? DEFAULT_PORTS : ports;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed[0] !== '{') {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return typeof parsed === 'object' && parsed != null
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}
