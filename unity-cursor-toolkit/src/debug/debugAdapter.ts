/**
 * Debug Adapter for Unity's Mono soft debugger.
 * Implements DAP (Debug Adapter Protocol) with stubbed Mono wire protocol.
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';

const DEFAULT_MONO_DEBUG_PORT = 56000;

/** DAP request message shape (opaque in API, we cast for handling). */
interface DapRequest {
	seq?: number;
	type?: string;
	command?: string;
	arguments?: Record<string, unknown>;
}

/** DAP response body types. */
interface InitializeResponseBody {
	supportsConfigurationDoneRequest?: boolean;
	supportsFunctionBreakpoints?: boolean;
	supportsConditionalBreakpoints?: boolean;
	supportsHitConditionalBreakpoints?: boolean;
	supportsEvaluateForHover?: boolean;
	exceptionBreakpointFilters?: unknown[];
	supportsStepBack?: boolean;
	supportsSetVariable?: boolean;
	supportsRestartFrame?: boolean;
	supportsGotoTargetsRequest?: boolean;
	supportsStepInTargetsRequest?: boolean;
	supportsCompletionsRequest?: boolean;
	additionalModuleColumns?: unknown[];
	supportedChecksumAlgorithms?: unknown[];
}

/**
 * Unity debug session implementing the Debug Adapter Protocol.
 * Connects to Unity's Mono debugger port (default 56000).
 * Mono wire protocol is stubbed with TODO markers.
 */
export class UnityDebugSession implements vscode.DebugAdapter {

	private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public readonly onDidSendMessage = this._onDidSendMessage.event;

	private _disposed = false;
	private _monoPort: number;
	private _sessionConfig: vscode.DebugConfiguration | undefined;

	constructor(monoPort?: number) {
		this._monoPort = monoPort ?? DEFAULT_MONO_DEBUG_PORT;
	}

	public setConfiguration(config: vscode.DebugConfiguration): void {
		this._sessionConfig = config;
		const port = config.debugPort ?? config.port ?? this._monoPort;
		if (typeof port === 'number') {
			this._monoPort = port;
		}
	}

	public handleMessage(message: vscode.DebugProtocolMessage): void {
		if (this._disposed) {
			return;
		}

		const req = message as DapRequest;
		if (req.type !== 'request' || req.command == null) {
			return;
		}

		const seq = req.seq ?? 0;

		const cmd = req.command;
		switch (cmd) {
			case 'initialize':
				this.handleInitialize(cmd, seq, req.arguments);
				break;
			case 'attach':
				this.handleAttach(cmd, seq, req.arguments);
				break;
			case 'setBreakpoints':
				this.handleSetBreakpoints(cmd, seq, req.arguments);
				break;
			case 'threads':
				this.handleThreads(cmd, seq);
				break;
			case 'stackTrace':
				this.handleStackTrace(cmd, seq, req.arguments);
				break;
			case 'scopes':
				this.handleScopes(cmd, seq, req.arguments);
				break;
			case 'variables':
				this.handleVariables(cmd, seq, req.arguments);
				break;
			case 'continue':
				this.handleContinue(cmd, seq, req.arguments);
				break;
			case 'next':
				this.handleNext(cmd, seq, req.arguments);
				break;
			case 'stepIn':
				this.handleStepIn(cmd, seq, req.arguments);
				break;
			case 'stepOut':
				this.handleStepOut(cmd, seq, req.arguments);
				break;
			case 'disconnect':
				this.handleDisconnect(cmd, seq, req.arguments);
				break;
			default:
				this.sendResponse(cmd, seq, false, `Unknown command: ${cmd}`);
		}
	}

	private sendResponse(
		command: string,
		requestSeq: number,
		success: boolean,
		message?: string,
		body?: unknown
	): void {
		this._onDidSendMessage.fire({
			type: 'response',
			seq: this.nextSeq(),
			request_seq: requestSeq,
			success,
			command,
			message: message ?? (success ? undefined : 'Request failed'),
			body
		} as vscode.DebugProtocolMessage);
	}

	private sendEvent(event: string, body?: unknown): void {
		this._onDidSendMessage.fire({
			type: 'event',
			seq: this.nextSeq(),
			event,
			body
		} as vscode.DebugProtocolMessage);
	}

	private _responseSeq = 1;
	private nextSeq(): number {
		return this._responseSeq++;
	}

	private handleInitialize(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		const body: InitializeResponseBody = {
			supportsConfigurationDoneRequest: true,
			supportsFunctionBreakpoints: false,
			supportsConditionalBreakpoints: true,
			supportsHitConditionalBreakpoints: false,
			supportsEvaluateForHover: true,
			exceptionBreakpointFilters: [],
			supportsStepBack: false,
			supportsSetVariable: false,
			supportsRestartFrame: false,
			supportsGotoTargetsRequest: false,
			supportsStepInTargetsRequest: false,
			supportsCompletionsRequest: false,
			additionalModuleColumns: [],
			supportedChecksumAlgorithms: []
		};

		this.sendResponse('initialize', seq, true, undefined, body);
		this.sendEvent('initialized');
	}

	private handleAttach(_cmd: string, seq: number, args?: Record<string, unknown>): void {
		const port = (args?.port as number) ?? this._monoPort;
		this._monoPort = port;

		// TODO: Connect to Unity's Mono debugger on port. Wire protocol:
		// - TCP connect to localhost:port
		// - Mono soft debugger protocol handshake
		// - VM suspend, enable events
		// Until implemented, we report success and the session appears attached.
		this.sendResponse('attach', seq, true);
	}

	private handleSetBreakpoints(_cmd: string, seq: number, args?: Record<string, unknown>): void {
		const source = args?.source as { path?: string } | undefined;
		const _bpRequests = (args?.breakpoints as Array<{ line?: number; column?: number }>) ?? [];
		const path = source?.path ?? '';

		// TODO: Send breakpoints to Mono debugger via wire protocol.
		// Map path/line to method/il offset and send MSG_SET_BREAKPOINT.
		const breakpoints = _bpRequests.map((bp) => ({
			id: 0,
			verified: true,
			line: bp.line ?? 0
		}));

		this.sendResponse('setBreakpoints', seq, true, undefined, { breakpoints });
	}

	private handleThreads(_cmd: string, seq: number): void {
		// TODO: Query Mono debugger for threads via wire protocol.
		// MSG_GET_THREADS or equivalent.
		const threads = [{ id: 1, name: 'Main Thread' }];
		this.sendResponse('threads', seq, true, undefined, { threads });
	}

	private handleStackTrace(_cmd: string, seq: number, args?: Record<string, unknown>): void {
		const _threadId = (args?.threadId as number) ?? 1;

		// TODO: Query Mono debugger for stack frames via wire protocol.
		const stackFrames = [
			{ id: 1, name: '[stub] Main', line: 0, column: 0 }
		];
		this.sendResponse('stackTrace', seq, true, undefined, { stackFrames });
	}

	private handleScopes(_cmd: string, seq: number, args?: Record<string, unknown>): void {
		const _frameId = (args?.frameId as number) ?? 1;

		// TODO: Query Mono debugger for scopes (locals, args) via wire protocol.
		const scopes = [
			{ name: 'Local', variablesReference: 1, expensive: false }
		];
		this.sendResponse('scopes', seq, true, undefined, { scopes });
	}

	private handleVariables(_cmd: string, seq: number, args?: Record<string, unknown>): void {
		const _variablesReference = (args?.variablesReference as number) ?? 1;

		// TODO: Query Mono debugger for variable values via wire protocol.
		const variables: Array<{ name: string; value: string; variablesReference: number }> = [];
		this.sendResponse('variables', seq, true, undefined, { variables });
	}

	private handleContinue(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		// TODO: Send continue command to Mono debugger via wire protocol. Use _args.threadId.
		this.sendResponse('continue', seq, true);
	}

	private handleNext(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		// TODO: Send step-over command to Mono debugger via wire protocol. Use _args.threadId.
		this.sendResponse('next', seq, true);
	}

	private handleStepIn(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		// TODO: Send step-in command to Mono debugger via wire protocol. Use _args.threadId.
		this.sendResponse('stepIn', seq, true);
	}

	private handleStepOut(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		// TODO: Send step-out command to Mono debugger via wire protocol. Use _args.threadId.
		this.sendResponse('stepOut', seq, true);
	}

	private handleDisconnect(_cmd: string, seq: number, _args?: Record<string, unknown>): void {
		// TODO: Disconnect from Mono debugger, close TCP socket.
		this._disposed = true;
		this.sendResponse('disconnect', seq, true);
		this.sendEvent('terminated');
	}

	public dispose(): void {
		this._disposed = true;
		this._onDidSendMessage.dispose();
	}
}

/**
 * Factory that creates inline debug adapter descriptors for Unity attach sessions.
 */
export class UnityDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		_executable: vscode.DebugAdapterExecutable | undefined
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		const config = session.configuration;
		const port = (config.debugPort ?? config.port ?? 56000) as number;
		const adapter = new UnityDebugSession(port);
		adapter.setConfiguration(config);
		return new vscode.DebugAdapterInlineImplementation(adapter);
	}
}
