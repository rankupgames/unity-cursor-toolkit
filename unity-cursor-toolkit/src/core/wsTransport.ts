/**
 * WebSocket transport -- server for remote MCP clients.
 * Uses ws package via dynamic import; graceful fallback when not installed.
 *
 * TODO: Will be integrated into the MCP module for remote access.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { IncomingMessage } from './types';

interface WsClient {
	readyState: number;
	send(data: string): void;
	on(event: string, fn: (...args: unknown[]) => void): void;
	close(): void;
}

interface WsServer {
	on(event: string, fn: (...args: unknown[]) => void): void;
	close(): void;
}

export class WebSocketTransport {
	private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
	readonly onMessage: vscode.Event<IncomingMessage> = this._onMessage.event;

	private server: WsServer | undefined;
	private clients: Set<WsClient> = new Set();

	async start(port: number): Promise<boolean> {
		let wsModule: { WebSocketServer: new (opts: { port: number }) => WsServer };
		try {
			// @ts-expect-error ws is optional; dynamic import for graceful fallback when not installed
			wsModule = await import('ws');
		} catch {
			console.warn('[WebSocketTransport] ws package not installed. Add ws as optionalPeerDependency for remote transport.');
			return false;
		}

		if (this.server) {
			return true;
		}

		const { WebSocketServer } = wsModule;
		this.server = new WebSocketServer({ port });
		this.clients = new Set();

		this.server.on('connection', ((ws: WsClient) => {
			this.clients.add(ws);

			ws.on('message', ((raw: Buffer | string) => {
				const text = typeof raw === 'string' ? raw : raw.toString();
				const trimmed = text.trim();
				if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return;

				try {
					const parsed = JSON.parse(trimmed) as Record<string, unknown>;
					const command = parsed.command as string | undefined;
					if (command) {
						this._onMessage.fire({ command, payload: parsed });
					}
				} catch {
					// ignore malformed JSON
				}
			}) as (...args: unknown[]) => void);

			ws.on('close', () => this.clients.delete(ws));
		}) as (...args: unknown[]) => void);

		return true;
	}

	stop(): void {
		if (this.server) {
			for (const ws of this.clients) {
				ws.close();
			}
			this.clients.clear();
			this.server.close();
			this.server = undefined;
		}
	}

	broadcast(command: string, payload?: Record<string, unknown>): void {
		const data = JSON.stringify({ command, ...payload });
		for (const ws of this.clients) {
			if (ws.readyState === 1) {
				ws.send(data);
			}
		}
	}
}
