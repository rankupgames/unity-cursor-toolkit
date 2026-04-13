/**
 * Command Sender -- request/response abstraction over IConnectionManager.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import { ICommandSender, IConnectionManager } from './interfaces';
import { IncomingMessage } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

export class CommandSender implements ICommandSender {

	private readonly connection: IConnectionManager;
	private pendingRequests = new Map<string, {
		resolve: (value: Record<string, unknown> | null) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private requestCounter = 0;

	constructor(connection: IConnectionManager) {
		this.connection = connection;
		connection.onMessage((msg) => this.handleResponse(msg));
	}

	public send(command: string, payload?: Record<string, unknown>): void {
		this.connection.send(command, payload);
	}

	public request(command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const requestId = `req_${++this.requestCounter}_${Date.now()}`;

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				resolve(null);
			}, DEFAULT_TIMEOUT_MS);

			this.pendingRequests.set(requestId, { resolve, timer });
			this.connection.send(command, { ...payload, _requestId: requestId });
		});
	}

	public dispose(): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.pendingRequests.clear();
	}

	private handleResponse(msg: IncomingMessage): void {
		const requestId = msg.payload._requestId as string | undefined;
		if (requestId == null) {
			return;
		}

		const pending = this.pendingRequests.get(requestId);
		if (pending == null) {
			return;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(requestId);
		pending.resolve(msg.payload);
	}
}
