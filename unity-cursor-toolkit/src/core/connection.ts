/**
 * Connection Manager -- composable TCP connection to Unity with state machine,
 * heartbeat, and exponential backoff reconnect.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import * as net from 'net';
import { ConnectionState, safeJsonParse } from './types';
import type { ConnectionInfo, IncomingMessage } from './types';
import type { IConnectionManager } from './interfaces';

const DEFAULT_PORTS = [55500, 55501, 55502, 55503, 55504] as const;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

export class ConnectionManager implements IConnectionManager, vscode.Disposable {

	private readonly _onStateChanged = new vscode.EventEmitter<ConnectionInfo>();
	private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();

	public readonly onStateChanged: vscode.Event<ConnectionInfo> = this._onStateChanged.event;
	public readonly onMessage: vscode.Event<IncomingMessage> = this._onMessage.event;

	private state: ConnectionState = ConnectionState.Disconnected;
	private socket: net.Socket | undefined;
	private port: number | null = null;
	private dataBuffer = '';

	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private connectPromise: Promise<number | null> | undefined;
	private connectExcludedPorts: ReadonlySet<number> | undefined;
	private connectGeneration = 0;
	private backoffMs = INITIAL_BACKOFF_MS;

	private isNeeded: () => boolean = () => false;
	private reconnect: (() => Promise<number | null | undefined>) | undefined;
	private directConnectionRequested = false;
	private disposed = false;
	private heartbeatPaused = false;

	constructor(private readonly ports: readonly number[] = DEFAULT_PORTS) {}

	public get info(): ConnectionInfo {
		return { state: this.state, port: this.port };
	}

	public setNeededCallback(callback: () => boolean): void {
		this.isNeeded = callback;
	}

	public setReconnectCallback(callback: () => Promise<number | null | undefined>): void {
		this.reconnect = callback;
	}

	public async connect(): Promise<number | null> {
		this.directConnectionRequested = true;
		const port = await this.connectWithExcludedPorts(new Set<number>());
		if (port == null) {
			this.directConnectionRequested = false;
		}
		return port;
	}

	/**
	 * Connect to the first responsive configured port that is not excluded.
	 *
	 * A rejected port only applies to this connection attempt. Calls with the
	 * same exclusions share the in-flight scan; a conflicting scan fails closed
	 * so it cannot accidentally connect to a port the caller rejected.
	 */
	public async connectExcludingPorts(excludedPorts: ReadonlySet<number> | readonly number[]): Promise<number | null> {
		const exclusions = new Set(excludedPorts);
		return this.connectWithExcludedPorts(exclusions);
	}

	private async connectWithExcludedPorts(excludedPorts: ReadonlySet<number>): Promise<number | null> {
		if (this.state === ConnectionState.Connected && this.socket != null && this.socket.writable && this.port != null) {
			if (excludedPorts.has(this.port) === false) {
				return this.port;
			}

			this.disconnect();
		}

		if (this.connectPromise != null) {
			return this.connectExcludedPorts != null && this.haveSameExcludedPorts(this.connectExcludedPorts, excludedPorts)
				? this.connectPromise
				: null;
		}

		const promise = this.connectOnce(excludedPorts);
		this.connectPromise = promise;
		this.connectExcludedPorts = excludedPorts;
		try {
			return await promise;
		} finally {
			if (this.connectPromise === promise) {
				this.connectPromise = undefined;
				this.connectExcludedPorts = undefined;
			}
		}
	}

	private async connectOnce(excludedPorts: ReadonlySet<number>): Promise<number | null> {
		const generation = ++this.connectGeneration;
		this.setState(ConnectionState.Connecting);
		this.destroySocket();

		for (const candidate of this.ports) {
			if (this.disposed) {
				break;
			}
			if (excludedPorts.has(candidate)) {
				continue;
			}

			const socket = await this.tryPort(candidate);
			if (this.disposed || generation !== this.connectGeneration) {
				socket?.destroy();
				return null;
			}
			if (socket) {
				this.socket = socket;
				this.attachSocketListeners(socket);
				this.port = candidate;
				this.backoffMs = INITIAL_BACKOFF_MS;
				this.setState(ConnectionState.Connected);
				this.startHeartbeat();
				return candidate;
			}
		}

		if (generation === this.connectGeneration) {
			this.setState(ConnectionState.Disconnected);
		}
		return null;
	}

	private haveSameExcludedPorts(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
		if (left.size !== right.size) {
			return false;
		}

		for (const port of left) {
			if (right.has(port) === false) {
				return false;
			}
		}

		return true;
	}

	public send(command: string, payload?: Record<string, unknown>): void {
		if (this.state !== ConnectionState.Connected || this.socket == null || this.socket.writable === false) {
			return;
		}

		const data = JSON.stringify({ command, ...payload });
		this.socket.write(data + '\n');
	}

	public disconnect(): void {
		this.directConnectionRequested = false;
		this.connectGeneration++;
		this.connectPromise = undefined;
		this.connectExcludedPorts = undefined;
		this.clearTimers();
		this.destroySocket();
		this.port = null;
		this.backoffMs = INITIAL_BACKOFF_MS;
		this.setState(ConnectionState.Disconnected);
	}

	public pauseHeartbeat(): void {
		this.heartbeatPaused = true;
		this.stopHeartbeat();
	}

	public resumeHeartbeat(): void {
		this.heartbeatPaused = false;
		if (this.state === ConnectionState.Connected) {
			this.startHeartbeat();
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.disconnect();
		this._onStateChanged.dispose();
		this._onMessage.dispose();
	}

	private setState(next: ConnectionState): void {
		if (this.state === next) {
			return;
		}
		this.state = next;
		this._onStateChanged.fire({ state: next, port: this.port });
	}

	private tryPort(port: number): Promise<net.Socket | null> {
		return new Promise<net.Socket | null>((resolve) => {
			const sock = new net.Socket();
			let settled = false;
			let buffer = '';

			const settle = (success: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				sock.removeAllListeners();

				if (success) {
					resolve(sock);
				} else {
					sock.destroy();
					resolve(null);
				}
			};

			sock.setTimeout(2_000);
			sock.once('connect', () => {
				sock.write('{"command":"ping"}\n');
			});
			sock.on('data', (raw: Buffer) => {
				buffer += raw.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					let parsed: Record<string, unknown> | null;
					try {
						parsed = safeJsonParse(line);
					} catch {
						settle(false);
						return;
					}
					if (parsed?.command === 'pong') {
						sock.setTimeout(0);
						settle(true);
						return;
					}
				}
			});
			sock.once('error', () => settle(false));
			sock.once('timeout', () => settle(false));
			sock.connect(port, 'localhost');
		});
	}

	private attachSocketListeners(sock: net.Socket): void {
		sock.on('data', (raw: Buffer) => {
			this.dataBuffer += raw.toString();
			const lines = this.dataBuffer.split('\n');
			this.dataBuffer = lines.pop() ?? '';

			for (const line of lines) {
				let parsed: Record<string, unknown> | null;
				try {
					parsed = safeJsonParse(line);
				} catch (error) {
					console.warn(`[Connection] Ignoring malformed JSON from Unity: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				if (parsed == null) {
					continue;
				}

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
			console.error(`[Connection] Socket error: ${err.message}`);
		});
	}

	private handleDisconnect(): void {
		this.stopHeartbeat();

		if (this.disposed || this.hasConnectionDemand() === false) {
			this.setState(ConnectionState.Disconnected);
			return;
		}

		this.setState(ConnectionState.Reconnecting);
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}

		this.reconnectTimer = setTimeout(async () => {
			if (this.disposed || this.hasConnectionDemand() === false) {
				this.setState(ConnectionState.Disconnected);
				return;
			}

			const port = this.isNeeded()
				? await (this.reconnect?.() ?? this.connectWithExcludedPorts(new Set<number>()))
				: await this.connectWithExcludedPorts(new Set<number>());
			if (this.disposed || this.hasConnectionDemand() === false) {
				this.setState(ConnectionState.Disconnected);
				return;
			}
			if (port === undefined) {
				return;
			}
			if (port == null) {
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
				this.setState(ConnectionState.Reconnecting);
				this.scheduleReconnect();
			}
		}, this.backoffMs);
	}

	private hasConnectionDemand(): boolean {
		return this.directConnectionRequested || this.isNeeded();
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();

		if (this.heartbeatPaused) {
			return;
		}

		this.heartbeatTimer = setInterval(() => {
			if (this.state !== ConnectionState.Connected) {
				return;
			}

			this.send('ping');

			this.heartbeatTimeout = setTimeout(() => {
				console.warn('[Connection] Heartbeat timeout -- reconnecting');
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
