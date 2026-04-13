/**
 * Core interfaces -- contracts that every module codes against.
 * Core imports nothing from any feature module.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';

export interface IModule {
	readonly id: string;
	activate(ctx: ModuleContext): Promise<void>;
	deactivate(): Promise<void>;
}

export interface ModuleContext {
	readonly commandSender: ICommandSender;
	readonly extensionContext: vscode.ExtensionContext;
	readonly connectionManager: IConnectionManager;
	registerMessageHandler(handler: IMessageHandler): void;
	registerToolProvider(provider: IToolProvider): void;
	registerStatusBarContributor(contributor: IStatusBarContributor): void;
	registerCommand(id: string, callback: (...args: unknown[]) => unknown): void;
}

export interface IConnectionManager {
	readonly onStateChanged: vscode.Event<import('./types').ConnectionInfo>;
	readonly onMessage: vscode.Event<import('./types').IncomingMessage>;
	readonly info: import('./types').ConnectionInfo;
	connect(): Promise<number | null>;
	disconnect(): void;
	send(command: string, payload?: Record<string, unknown>): void;
	pauseHeartbeat(): void;
	resumeHeartbeat(): void;
}

export interface ICommandSender {
	send(command: string, payload?: Record<string, unknown>): void;
	request(command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

export interface IMessageHandler {
	readonly commandFilter: string;
	handle(payload: Record<string, unknown>): void;
}

export interface IToolProvider {
	readonly toolGroupName: string;
	getTools(): ToolDefinition[];
	handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

export interface IStatusBarContributor {
	readonly group: string;
	getActions(): QuickAccessAction[];
}

export interface QuickAccessAction {
	label: string;
	description?: string;
	command: string;
	args?: unknown[];
}
