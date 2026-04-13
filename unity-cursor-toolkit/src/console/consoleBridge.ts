/**
 * Console Bridge -- routes Unity console messages to the console panel and Cursor chat
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IConnectionManager } from '../core/interfaces';
import type { ConsoleEntry, IncomingMessage } from '../core/types';

export interface ConsoleFilterOptions {
	level?: string;
	limit?: number;
	search?: string;
}

export interface ConsoleBulkPayload {
	readonly content: string;
	readonly entryCount: number;
}

export class ConsoleBridge implements vscode.Disposable {

	private readonly _onEntry = new vscode.EventEmitter<ConsoleEntry>();
	private readonly _onBulk = new vscode.EventEmitter<ConsoleBulkPayload>();
	private readonly _onClear = new vscode.EventEmitter<void>();

	public readonly onEntry: vscode.Event<ConsoleEntry> = this._onEntry.event;
	public readonly onBulk: vscode.Event<ConsoleBulkPayload> = this._onBulk.event;
	public readonly onClear: vscode.Event<void> = this._onClear.event;

	private entries: ConsoleEntry[] = [];
	private disposables: vscode.Disposable[] = [];

	constructor(connection: IConnectionManager) {
		this.disposables.push(
			connection.onMessage((msg) => this.handleMessage(msg))
		);
	}

	public getEntries(options?: ConsoleFilterOptions): ConsoleEntry[] {
		let result = [...this.entries];

		if (options?.level) {
			result = result.filter((e) => e.type === options.level);
		}
		if (options?.search) {
			const term = options.search.toLowerCase();
			result = result.filter((e) => e.message.toLowerCase().includes(term) || e.stackTrace.toLowerCase().includes(term));
		}
		if (options?.limit && options.limit > 0) {
			result = result.slice(-options.limit);
		}

		return result;
	}

	public clearEntries(): void {
		this.entries = [];
		this._onClear.fire();
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this._onEntry.dispose();
		this._onBulk.dispose();
		this._onClear.dispose();
	}

	public async sendToChat(content: string, entryCount: number): Promise<void> {
		await vscode.env.clipboard.writeText(content);

		const chatCommands = [
			'workbench.action.chat.newChat',
			'aichat.newchataction',
			'workbench.action.chat.open'
		];

		const available = await vscode.commands.getCommands(true);
		for (const cmd of chatCommands) {
			if (available.includes(cmd)) {
				await vscode.commands.executeCommand(cmd);
				break;
			}
		}

		vscode.window.showInformationMessage(
			`${entryCount} console entries copied to clipboard. Paste into the chat window.`
		);
	}

	private handleMessage(msg: IncomingMessage): void {
		if (msg.command === 'consoleEntry') {
			const entry: ConsoleEntry = {
				type: this.mapLogType(msg.payload.type as string),
				message: (msg.payload.message as string) ?? '',
				stackTrace: (msg.payload.stackTrace as string) ?? '',
				timestamp: (msg.payload.timestamp as string) ?? new Date().toISOString()
			};

			const maxEntries = vscode.workspace.getConfiguration('unityCursorToolkit.console').get<number>('maxEntries', 10_000);
			this.entries.push(entry);
			if (this.entries.length > maxEntries) {
				this.entries.shift();
			}

			this._onEntry.fire(entry);
		} else if (msg.command === 'consoleToCursor') {
			const content = msg.payload.content as string | undefined;
			const entryCount = (msg.payload.entryCount as number) ?? 0;

			if (content) {
				this._onBulk.fire({ content, entryCount });
				this.sendToChat(content, entryCount);
			}
		}
	}

	private mapLogType(raw: string | undefined): ConsoleEntry['type'] {
		switch (raw) {
			case 'Error': return 'error';
			case 'Exception': return 'exception';
			case 'Warning': return 'warning';
			case 'Assert': return 'assert';
			default: return 'log';
		}
	}
}
