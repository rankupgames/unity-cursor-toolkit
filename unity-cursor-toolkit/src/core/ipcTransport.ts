/**
 * IPC transport -- named pipes (Windows) / Unix domain sockets (Mac/Linux).
 * Same connection pattern as TCP ConnectionManager: heartbeat, reconnect, message parsing.
 *
 * TODO: Will be wired into a transport factory in a future iteration.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as net from 'net';
import { ConnectionState, ConnectionInfo, IncomingMessage, safeJsonParse } from './types';

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
const SOCKET_PATH_WIN = '\\\\.\\pipe\\unity-cursor-toolkit';
const SOCKET_PATH_UNIX = '/tmp/unity-cursor-toolkit.sock';

const SOCKET_PATH = process.platform === 'win32' ? SOCKET_PATH_WIN : SOCKET_PATH_UNIX;

export class IpcTransport {
	private readonly _onStateChanged = new vscode.EventEmitter<ConnectionInfo>();
	private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();

	readonly onStateChanged: vscode.Event<ConnectionInfo> = this._onStateChanged.event;
	readonly onMessage: vscode.Event<IncomingMessage> = this._onMessage.event;

	private state: ConnectionState = ConnectionState.Disconnected;
	private socket: net.Socket | undefined;
	private dataBuffer = '';

	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private backoffMs = INITIAL_BACKOFF_MS;

	private isNeeded: () => boolean = () => false;
	private disposed = false;

	get info(): ConnectionInfo {
		return { state: this.state, port: null };
	}

	setNeededCallback(callback: () => boolean): void {
		this.isNeeded = callback;
	}

	async connect(): Promise<number | null> {
		if (this.state === ConnectionState.Connecting) {
			return null;
		}

		this.setState(ConnectionState.Connecting);
		this.destroySocket();

		const success = await this.tryConnect();
		if (success && !this.disposed) {
			this.backoffMs = INITIAL_BACKOFF_MS;
			this.setState(ConnectionState.Connected);
			this.startHeartbeat();
			return 0;
		}

		this.setState(ConnectionState.Disconnected);
		return null;
	}

	send(command: string, payload?: Record<string, unknown>): void {
		if (this.state !== ConnectionState.Connected || this.socket == null || !this.socket.writable) {
			return;
		}

		const data = JSON.stringify({ command, ...payload });
		this.socket.write(data + '\n');
	}

	disconnect(): void {
		this.clearTimers();
		this.destroySocket();
		this.backoffMs = INITIAL_BACKOFF_MS;
		this.setState(ConnectionState.Disconnected);
	}

	private setState(next: ConnectionState): void {
		if (this.state === next) return;
		this.state = next;
		this._onStateChanged.fire({ state: next, port: null });
	}

	private tryConnect(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const sock = new net.Socket();
			let settled = false;

			const settle = (success: boolean) => {
				if (settled) return;
				settled = true;
				sock.removeAllListeners();

				if (success) {
					this.socket = sock;
					this.attachSocketListeners(sock);
					resolve(true);
				} else {
					sock.destroy();
					resolve(false);
				}
			};

			sock.setTimeout(2_000);
			sock.once('connect', () => {
				sock.setTimeout(0);
				settle(true);
			});
			sock.once('error', () => settle(false));
			sock.once('timeout', () => settle(false));
			sock.connect({ path: SOCKET_PATH });
		});
	}

	private attachSocketListeners(sock: net.Socket): void {
		sock.on('data', (raw: Buffer) => {
			this.dataBuffer += raw.toString();
			const lines = this.dataBuffer.split('\n');
			this.dataBuffer = lines.pop() ?? '';

			for (const line of lines) {
				const parsed = safeJsonParse(line);
				if (parsed == null) continue;

				const command = parsed.command as string | undefined;
				if (command === 'pong') {
					this.onPongReceived();
					continue;
				}
				if (command) {
					this._onMessage.fire({ command, payload: parsed });
				}
			}
		});

		sock.on('close', () => this.handleDisconnect());
		sock.on('error', (err) => {
			console.error(`[IpcTransport] Socket error: ${err.message}`);
		});
	}

	private handleDisconnect(): void {
		this.stopHeartbeat();

		if (this.disposed || !this.isNeeded()) {
			this.setState(ConnectionState.Disconnected);
			return;
		}

		this.setState(ConnectionState.Reconnecting);
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

		this.reconnectTimer = setTimeout(async () => {
			if (this.disposed || !this.isNeeded()) {
				this.setState(ConnectionState.Disconnected);
				return;
			}

			const ok = await this.connect();
			if (ok == null) {
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
				this.setState(ConnectionState.Reconnecting);
				this.scheduleReconnect();
			}
		}, this.backoffMs);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();

		this.heartbeatTimer = setInterval(() => {
			if (this.state !== ConnectionState.Connected) return;

			this.send('ping');

			this.heartbeatTimeout = setTimeout(() => {
				console.warn('[IpcTransport] Heartbeat timeout -- reconnecting');
				this.destroySocket();
				this.handleDisconnect();
			}, HEARTBEAT_TIMEOUT_MS);
		}, HEARTBEAT_INTERVAL_MS);
	}

	private onPongReceived(): void {
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = undefined;
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = undefined;
		}
	}

	private clearTimers(): void {
		this.stopHeartbeat();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private destroySocket(): void {
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = undefined;
		}
		this.dataBuffer = '';
	}
}
