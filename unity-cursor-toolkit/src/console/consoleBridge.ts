/**
 * Console Bridge -- routes Unity console messages to the console panel and Cursor chat
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import type { IConnectionManager } from '../core/interfaces';
import type { ConsoleEntry, IncomingMessage } from '../core/types';

const DEFAULT_MAX_ENTRIES = 1_000;
const MAX_CONSOLE_ENTRIES = 1_000;
const MAX_MESSAGE_CHARS = 4_096;
const MAX_STACK_TRACE_CHARS = 16_384;
const TRUNCATION_SUFFIX = '… [truncated]';

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
	private nextEntryIndex = 0;
	private maxEntries = DEFAULT_MAX_ENTRIES;
	private disposables: vscode.Disposable[] = [];

	constructor(connection: IConnectionManager) {
		this.disposables.push(
			connection.onMessage((msg) => this.handleMessage(msg))
		);
	}

	public getEntries(options?: ConsoleFilterOptions): ConsoleEntry[] {
		this.syncMaxEntries();
		let result = this.getOrderedEntries();

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
		this.nextEntryIndex = 0;
		this._onClear.fire();
	}

	public getMaxEntries(): number {
		return this.readMaxEntries();
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
				type: this.mapLogType(this.getPayloadString(msg.payload.type)),
				message: this.truncateText(this.getPayloadString(msg.payload.message) ?? '', MAX_MESSAGE_CHARS),
				stackTrace: this.truncateText(this.getPayloadString(msg.payload.stackTrace) ?? '', MAX_STACK_TRACE_CHARS),
				timestamp: this.getPayloadString(msg.payload.timestamp) ?? new Date().toISOString()
			};

			this.syncMaxEntries();
			this.addEntry(entry);

			this._onEntry.fire(entry);
		} else if (msg.command === 'consoleToCursor') {
			const content = this.getPayloadString(msg.payload.content);
			const entryCount = this.getPayloadNumber(msg.payload.entryCount) ?? 0;

			if (content) {
				this._onBulk.fire({ content, entryCount });
				this.sendToChat(content, entryCount);
			}
		}
	}

	private addEntry(entry: ConsoleEntry): void {
		if (this.entries.length < this.maxEntries) {
			this.entries.push(entry);
			return;
		}

		this.entries[this.nextEntryIndex] = entry;
		this.nextEntryIndex = (this.nextEntryIndex + 1) % this.maxEntries;
	}

	private getOrderedEntries(): ConsoleEntry[] {
		if (this.entries.length < this.maxEntries || this.nextEntryIndex === 0) {
			return [...this.entries];
		}

		return [
			...this.entries.slice(this.nextEntryIndex),
			...this.entries.slice(0, this.nextEntryIndex)
		];
	}

	private syncMaxEntries(): void {
		const configuredMax = this.readMaxEntries();
		if (configuredMax === this.maxEntries) {
			return;
		}

		const retained = this.getOrderedEntries().slice(-configuredMax);
		this.entries = retained;
		this.nextEntryIndex = 0;
		this.maxEntries = configuredMax;
	}

	private readMaxEntries(): number {
		const configured = vscode.workspace.getConfiguration('unityCursorToolkit.console').get<number>('maxEntries', DEFAULT_MAX_ENTRIES);
		if (Number.isFinite(configured) === false || configured < 1) {
			return DEFAULT_MAX_ENTRIES;
		}

		return Math.min(Math.floor(configured), MAX_CONSOLE_ENTRIES);
	}

	private getPayloadString(value: unknown): string | undefined {
		return typeof value === 'string' ? value : undefined;
	}

	private getPayloadNumber(value: unknown): number | undefined {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}

	private truncateText(value: string, maxChars: number): string {
		if (value.length <= maxChars) {
			return value;
		}

		return value.slice(0, maxChars - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
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
