/**
 * Console Panel -- live Unity console feed in the sidebar
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { ConsoleBridge } from './consoleBridge';
import type { ConsoleEntry } from '../core/types';

const DEFAULT_MAX_ENTRIES = 10_000;

export class ConsolePanelProvider implements vscode.WebviewViewProvider {

	public static readonly viewId = 'unityConsole';

	private readonly extensionUri: vscode.Uri;
	private readonly bridge: ConsoleBridge;
	private currentView: vscode.WebviewView | undefined;
	private entries: ConsoleEntry[] = [];
	private disposables: vscode.Disposable[] = [];

	constructor(extensionUri: vscode.Uri, bridge: ConsoleBridge) {
		this.extensionUri = extensionUri;
		this.bridge = bridge;

		this.disposables.push(
			bridge.onEntry((entry) => {
				const maxEntries = vscode.workspace.getConfiguration('unityCursorToolkit.console').get<number>('maxEntries', DEFAULT_MAX_ENTRIES);
				this.entries.push(entry);
				if (this.entries.length > maxEntries) {
					this.entries.shift();
				}
				this.postEntry(entry);
			}),
			bridge.onClear(() => {
				this.entries = [];
				this.currentView?.webview.postMessage({ type: 'clear' });
			})
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.currentView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			if (msg == null) {
				return;
			}
			switch (msg.type) {
				case 'ready':
					this.postAllEntries();
					return;
				case 'clear':
					this.entries = [];
					return;
				case 'sendToChat': {
					const content = this.formatEntries(this.entries);
					this.bridge.sendToChat(content, this.entries.length);
					return;
				}
			case 'copy': {
				const text = (msg.text as string) ?? '';
				await vscode.env.clipboard.writeText(text);
				vscode.window.showInformationMessage('Console entries copied to clipboard.');
				return;
			}
			case 'openFile': {
				await this.openFileAtLine(msg.path, msg.line);
				return;
			}
			}
		});
	}

	public clear(): void {
		this.entries = [];
		this.bridge.clearEntries();
		this.currentView?.webview.postMessage({ type: 'clear' });
	}

	public async copyToClipboard(): Promise<void> {
		const content = this.formatEntries(this.entries);
		await vscode.env.clipboard.writeText(content);
		vscode.window.showInformationMessage(`${this.entries.length} console entries copied to clipboard.`);
	}

	public async snapshot(): Promise<void> {
		const errors = this.entries.filter((e) => e.type === 'error' || e.type === 'exception');
		const warnings = this.entries.filter((e) => e.type === 'warning');
		const recent = this.entries.slice(-10);

		const lines: string[] = [
			'## Unity Console Snapshot',
			''
		];

		if (errors.length > 0) {
			lines.push(`### Errors (${errors.length})`);
			for (const e of errors) {
				lines.push(`[ERROR] ${e.message}`);
				if (e.stackTrace) {
					const traceLines = e.stackTrace.split('\n').filter((l) => l.includes('Assets/'));
					for (const tl of traceLines) {
						lines.push(`  -> ${tl.trim()}`);
					}
				}
			}
			lines.push('');
		}

		if (warnings.length > 0) {
			lines.push(`### Warnings (${warnings.length})`);
			for (const w of warnings) {
				lines.push(`[WARN] ${w.message}`);
				if (w.stackTrace) {
					const traceLines = w.stackTrace.split('\n').filter((l) => l.includes('Assets/'));
					for (const tl of traceLines) {
						lines.push(`  -> ${tl.trim()}`);
					}
				}
			}
			lines.push('');
		}

		if (recent.length > 0) {
			lines.push(`### Recent Logs (last ${recent.length})`);
			for (const r of recent) {
				lines.push(`[${r.type.toUpperCase()}] ${r.message}`);
			}
		}

		const payload = lines.join('\n');
		await vscode.env.clipboard.writeText(payload);
		vscode.window.showInformationMessage('Console snapshot copied to clipboard.');
	}

	public async exportLogs(): Promise<void> {
		const uri = await vscode.window.showSaveDialog({
			filters: {
				'Log Files': ['log'],
				'JSON Files': ['json']
			},
			defaultUri: vscode.Uri.file(`unity-console-${Date.now()}.log`)
		});

		if (uri == null) {
			return;
		}

		let content: string;
		if (uri.fsPath.endsWith('.json')) {
			content = JSON.stringify(this.entries, null, 2);
		} else {
			content = this.formatEntries(this.entries);
		}

		const fs = await import('fs');
		await fs.promises.writeFile(uri.fsPath, content, 'utf-8');
		vscode.window.showInformationMessage(`Exported ${this.entries.length} entries to ${uri.fsPath}`);
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async openFileAtLine(filePath: string, line: number): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders == null) {
			return;
		}

		for (const folder of workspaceFolders) {
			const fullPath = vscode.Uri.joinPath(folder.uri, filePath);
			try {
				const doc = await vscode.workspace.openTextDocument(fullPath);
				const lineNum = Math.max(0, line - 1);
				const range = new vscode.Range(lineNum, 0, lineNum, 0);
				await vscode.window.showTextDocument(doc, { selection: range, preview: true });
				return;
		} catch (error: unknown) {
			console.debug(`[ConsolePanel] File not found in folder, trying next: ${error instanceof Error ? error.message : String(error)}`);
		}
		}
	}

	private postEntry(entry: ConsoleEntry): void {
		this.currentView?.webview.postMessage({ type: 'entry', entry });
	}

	private postAllEntries(): void {
		this.currentView?.webview.postMessage({ type: 'bulk', entries: this.entries });
	}

	private formatEntries(entries: ConsoleEntry[]): string {
		const lines = entries.map((e) => {
			const prefix = `[${e.type.toUpperCase()}]`;
			let line = `${prefix} [${e.timestamp}] ${e.message}`;
			if (e.stackTrace) {
				line += '\n' + e.stackTrace;
			}
			return line;
		});
		return 'Unity Console Output:\n---\n' + lines.join('\n\n');
	}

	private getHtml(webview: vscode.Webview): string {
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'unsafe-inline'`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Unity Console</title>
	<style>
		:root { color-scheme: var(--vscode-color-scheme); }
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body { font-family: var(--vscode-editor-font-family); font-size: 12px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

		.toolbar {
			display: flex; align-items: center; gap: 6px;
			padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editor-background); flex-shrink: 0;
		}
		.toolbar button, .toolbar select {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border, transparent);
			padding: 3px 8px; border-radius: 2px; font-size: 11px; cursor: pointer;
		}
		.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.toolbar input[type="text"] {
			background: var(--vscode-input-background); color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			padding: 3px 8px; border-radius: 2px; font-size: 11px; flex: 1; min-width: 80px;
		}
		.toolbar input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
		.count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
		.log-stack a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
		.log-stack a:hover { color: var(--vscode-textLink-activeForeground); }
		.highlight { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33)); border-radius: 2px; }

		.log-area { flex: 1; overflow-y: auto; padding: 4px 10px; background: var(--vscode-sideBar-background); }

		.log-entry { padding: 3px 0; border-bottom: 1px solid var(--vscode-editorWidget-border); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-all; }
		.log-entry.error { color: var(--vscode-errorForeground); }
		.log-entry.exception { color: var(--vscode-errorForeground); }
		.log-entry.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
		.log-entry.log { color: var(--vscode-foreground); }
		.log-entry.assert { color: var(--vscode-errorForeground); }
		.log-ts { color: var(--vscode-descriptionForeground); margin-right: 6px; }
		.log-stack { opacity: 0.65; font-size: 11px; margin-top: 2px; }
		.empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<div class="toolbar">
		<select id="filter">
			<option value="all">All</option>
			<option value="error">Errors</option>
			<option value="warning">Warnings</option>
			<option value="log">Logs</option>
		</select>
		<input type="text" id="search" placeholder="Search..." />
		<button id="copy" title="Copy">Copy</button>
		<button id="clear">Clear</button>
		<button id="chat">Send to Chat</button>
		<span class="count" id="count">0 entries</span>
	</div>
	<div class="log-area" id="log-area">
		<div class="empty" id="empty">Waiting for Unity console output...</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const logArea = document.getElementById('log-area');
		const emptyEl = document.getElementById('empty');
		const countEl = document.getElementById('count');
		const filterEl = document.getElementById('filter');
		const searchEl = document.getElementById('search');
		let entries = [];
		let autoScroll = true;
		let searchTerm = '';
		let searchTimer = null;

		function escapeHtml(s) {
			var d = document.createElement('div');
			d.textContent = s;
			return d.innerHTML;
		}

		var TRACE_RE = /\(at\s+(Assets\/[^:]+):(\d+)\)/g;

		function linkifyStack(stack) {
			var escaped = escapeHtml(stack);
			return escaped.replace(/\(at (Assets\/[^:]+):(\d+)\)/g, function(m, path, line) {
				return '(at <a data-path="' + escapeHtml(path) + '" data-line="' + line + '">' + escapeHtml(path) + ':' + line + '</a>)';
			});
		}

		function highlightText(text, term) {
			if (term.length === 0) return text;
			var escaped = escapeHtml(text);
			var safeTerm = term.replace(/[.*+?^$\\{\\}()|\\[\\]\\\\]/g, '\\\\$&');
			var re = new RegExp('(' + safeTerm + ')', 'gi');
			return escaped.replace(re, '<span class="highlight">$1</span>');
		}

		function renderEntry(e) {
			var div = document.createElement('div');
			div.className = 'log-entry ' + e.type;
			div.dataset.type = e.type;
			div.dataset.msg = (e.message || '').toLowerCase();

			var msgHtml = searchTerm ? highlightText(e.message, searchTerm) : escapeHtml(e.message);
			var html = '<span class="log-ts">' + escapeHtml(e.timestamp) + '</span>' + msgHtml;
			if (e.stackTrace) {
				html += '<div class="log-stack">' + linkifyStack(e.stackTrace) + '</div>';
			}
			div.innerHTML = html;
			return div;
		}

		function matchesSearch(e) {
			if (searchTerm.length === 0) return true;
			var term = searchTerm.toLowerCase();
			return (e.message || '').toLowerCase().includes(term) ||
				(e.stackTrace || '').toLowerCase().includes(term);
		}

		function applyFilter() {
			var f = filterEl.value;
			var all = logArea.querySelectorAll('.log-entry');
			var visible = 0;
			all.forEach(function(el) {
				var typeMatch = f === 'all' || el.dataset.type === f || (f === 'error' && el.dataset.type === 'exception');
				var searchMatch = searchTerm.length === 0 || (el.dataset.msg || '').includes(searchTerm.toLowerCase());
				var show = typeMatch && searchMatch;
				el.style.display = show ? '' : 'none';
				if (show) visible++;
			});
			countEl.textContent = visible + '/' + entries.length;
		}

		function rebuildAll() {
			logArea.innerHTML = '';
			if (entries.length === 0) {
				logArea.innerHTML = '<div class="empty">Waiting for Unity console output...</div>';
				countEl.textContent = '0';
				return;
			}
			entries.forEach(function(e) { logArea.appendChild(renderEntry(e)); });
			applyFilter();
			if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
		}

		function addEntry(e) {
			entries.push(e);
			var el = document.querySelector('.empty');
			if (el) el.remove();
			logArea.appendChild(renderEntry(e));
			applyFilter();
			if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
		}

		logArea.addEventListener('scroll', function() {
			autoScroll = logArea.scrollTop + logArea.clientHeight >= logArea.scrollHeight - 20;
		});

		logArea.addEventListener('click', function(evt) {
			var target = evt.target;
			if (target.tagName === 'A' && target.dataset.path) {
				vscode.postMessage({ type: 'openFile', path: target.dataset.path, line: parseInt(target.dataset.line, 10) || 1 });
			}
		});

		filterEl.addEventListener('change', applyFilter);

		searchEl.addEventListener('input', function() {
			if (searchTimer) clearTimeout(searchTimer);
			searchTimer = setTimeout(function() {
				searchTerm = searchEl.value.trim();
				rebuildAll();
			}, 200);
		});

		document.getElementById('copy').addEventListener('click', function() {
			var text = entries.map(function(e) {
				var line = '[' + e.type.toUpperCase() + '] [' + e.timestamp + '] ' + e.message;
				if (e.stackTrace) line += '\\n' + e.stackTrace;
				return line;
			}).join('\\n\\n');
			vscode.postMessage({ type: 'copy', text: text });
		});

		document.getElementById('clear').addEventListener('click', function() {
			entries = [];
			logArea.innerHTML = '<div class="empty">Cleared</div>';
			countEl.textContent = '0';
			vscode.postMessage({ type: 'clear' });
		});

		document.getElementById('chat').addEventListener('click', function() {
			vscode.postMessage({ type: 'sendToChat' });
		});

		window.addEventListener('message', function(event) {
			var msg = event.data || {};
			if (msg.type === 'entry') {
				addEntry(msg.entry);
			} else if (msg.type === 'bulk') {
				entries = msg.entries || [];
				rebuildAll();
			} else if (msg.type === 'clear') {
				entries = [];
				logArea.innerHTML = '<div class="empty">Cleared</div>';
				countEl.textContent = '0';
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
