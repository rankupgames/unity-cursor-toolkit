/**
 * Shared types and interfaces for Unity Cursor Toolkit
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';

export enum ConnectionState {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
	Reconnecting = 'reconnecting'
}

export interface ConnectionInfo {
	state: ConnectionState;
	port: number | null;
}

export interface CompilationResult {
	success: boolean;
	errors: number;
	warnings: number;
}

export interface ConsoleEntry {
	type: 'error' | 'warning' | 'log' | 'exception' | 'assert';
	message: string;
	stackTrace: string;
	timestamp: string;
}

export interface IncomingMessage {
	command: string;
	payload: Record<string, unknown>;
}

/** @deprecated Use IModule from interfaces.ts instead */
export interface IDisposableModule extends vscode.Disposable {
	readonly id: string;
}

export const safeJsonParse = (text: string): Record<string, unknown> | null => {
	const trimmed = text.trim();
	if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
		return null;
	}

	return JSON.parse(trimmed) as Record<string, unknown>;
};
