// @ts-nocheck
/**
 * [WIP] Plastic SCM Timeline -- webview provider for VCS timeline visualization.
 * Currently disconnected from the extension. Not registered or activated.
 * Re-enable by wiring into extension.ts and package.json when ready.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';
import { listChangesets as listChangesetsCli, ListChangesetsOptions } from './plasticCli';
import { listChangesets as listChangesetsRest } from './plasticRest';

let _uiChannel: vscode.OutputChannel | undefined;
function uiChannel(): vscode.OutputChannel {
	if (!_uiChannel) {
		_uiChannel = vscode.window.createOutputChannel('Unity Cursor: Plastic Timeline (UI)');
	}
	return _uiChannel;
}

export class PlasticTimelineViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'plasticTimeline';

    private readonly extensionUri: vscode.Uri;
    private currentView: vscode.WebviewView | undefined;
    private currentOrder: 'newest-first' | 'oldest-first' = 'newest-first';
	private viewReady: boolean = false;

    public constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.currentView = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };

        const cfg = vscode.workspace.getConfiguration();
        this.currentOrder = (cfg.get<string>('unityCursorToolkit.plasticTimeline.order') as 'newest-first' | 'oldest-first') || 'newest-first';
        webviewView.webview.html = this.getHtml(webviewView.webview);

		uiChannel().appendLine('[UI] resolveWebviewView: initialized');

		// Message bridge from Webview
		webviewView.webview.onDidReceiveMessage((message) => {
			if (!message) return;
			switch (message.type) {
				case 'ready': {
					this.viewReady = true;
					uiChannel().appendLine('[UI] webview ready');
					this.fetchAndPost(webviewView.webview);
					return;
				}
				case 'refresh': {
					uiChannel().appendLine('[UI] refresh clicked');
					this.fetchAndPost(webviewView.webview);
					return;
				}
				case 'toggleOrder': {
					this.currentOrder = this.currentOrder === 'newest-first' ? 'oldest-first' : 'newest-first';
					uiChannel().appendLine(`[UI] order toggled -> ${this.currentOrder}`);
					this.fetchAndPost(webviewView.webview);
					return;
				}
				case 'vcsChanged': {
					const vcs = message.vcs ?? 'none';
					uiChannel().appendLine(`[UI] VCS changed to: ${vcs}`);
					// For now, only Plastic is implemented; GitHub/GitLab are future
					if (vcs === 'plastic') {
						this.fetchAndPost(webviewView.webview);
					} else {
						webviewView.webview.postMessage({ type: 'data', changes: [] });
						uiChannel().appendLine(`[UI] VCS "${vcs}" not yet implemented`);
					}
					return;
				}
				case 'ui/log': {
					uiChannel().appendLine(`[UI] ${message.message ?? ''}`);
					return;
				}
				case 'ui/error': {
					uiChannel().appendLine(`[UI][ERROR] ${message.message ?? ''}`);
					return;
				}
				default:
					return;
			}
		});

		// Defer initial fetch until the webview signals 'ready'
    }

    public refresh(): void {
        if (this.currentView) {
            this.currentView.webview.postMessage({ type: 'refresh' });
        }
    }

	private getHtml(webview: vscode.Webview): string {
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} https: data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'unsafe-inline'`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>VCS Timeline</title>
	<style>
		:root { color-scheme: var(--vscode-color-scheme); }
		* { box-sizing: border-box; }
		body { font-family: var(--vscode-font-family); margin: 0; padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editor-background);
			flex-shrink: 0;
		}
		.header-left { display: flex; align-items: center; gap: 12px; }
		.header-right { display: flex; align-items: center; gap: 6px; }
		.title { font-weight: 600; font-size: 13px; }
		select, button {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			padding: 4px 8px;
			border-radius: 2px;
			font-size: 12px;
			cursor: pointer;
		}
		select:hover, button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		select:disabled { opacity: 0.5; cursor: not-allowed; }

		.main-container {
			flex: 1;
			display: flex;
			flex-direction: column;
			overflow: hidden;
			position: relative;
		}

		.timeline-scroll {
			flex: 1;
			overflow-y: auto;
			overflow-x: hidden;
			padding: 12px 12px 12px 20px;
			background: var(--vscode-sideBar-background);
		}

		.timeline {
			display: flex;
			flex-direction: column;
			gap: 0;
			position: relative;
			padding-left: 40px;
		}

		.entry {
			display: grid;
			grid-template-columns: 60px 1fr;
			gap: 12px;
			align-items: start;
			cursor: pointer;
			padding: 4px 0;
			position: relative;
		}
		.entry:hover .card { background: var(--vscode-list-hoverBackground); }
		.entry.selected .card { background: var(--vscode-list-activeSelectionBackground); }

		.graph-cell {
			position: relative;
			height: 100%;
			min-height: 48px;
		}

		.graph-canvas {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: none;
		}

		.dot {
			position: absolute;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			background: var(--vscode-charts-blue);
			border: 3px solid var(--vscode-sideBar-background);
			z-index: 10;
			top: 16px;
		}

		.card {
			padding: 8px 12px;
			border-radius: 4px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-editorWidget-border);
			transition: background 0.1s;
			min-height: 48px;
		}
		.card-header {
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 12px;
			margin-bottom: 4px;
		}
		.cs-id { font-weight: 600; color: var(--vscode-terminal-ansiYellow); }
		.author { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.branch-tag {
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 3px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 200px;
		}
		.card-comment {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.muted { opacity: 0.75; font-size: 11px; }

		.resizer {
			height: 4px;
			background: var(--vscode-panel-border);
			cursor: ns-resize;
			flex-shrink: 0;
			position: relative;
		}
		.resizer:hover { background: var(--vscode-focusBorder); }
		.resizer::before {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			width: 40px;
			height: 2px;
			background: var(--vscode-descriptionForeground);
			opacity: 0.5;
		}

		.details-panel {
			background: var(--vscode-editor-background);
			height: 200px;
			overflow-y: auto;
			padding: 12px;
			flex-shrink: 0;
			font-size: 12px;
		}
		.details-panel.empty { display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
		.detail-row { margin-bottom: 8px; }
		.detail-label { font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 2px; font-size: 11px; }
		.detail-value { font-family: var(--vscode-editor-font-family); font-size: 12px; }
		.detail-comment { white-space: pre-wrap; line-height: 1.4; }
	</style>
</head>
<body>
	<div class="header">
		<div class="header-left">
			<div class="title">VCS Timeline</div>
			<select id="vcs-select">
				<option value="none">None</option>
				<option value="github">GitHub</option>
				<option value="gitlab" disabled>GitLab</option>
				<option value="plastic" selected>Plastic SCM</option>
			</select>
		</div>
		<div class="header-right">
			<button id="order">Order: ${this.currentOrder === 'newest-first' ? 'Newest First' : 'Oldest First'}</button>
			<button id="preview">Preview</button>
			<button id="refresh">Refresh</button>
		</div>
	</div>
	<div class="main-container">
		<div class="timeline-scroll" id="timeline-scroll">
			<div class="timeline" id="timeline"></div>
		</div>
		<div class="resizer" id="resizer"></div>
		<div class="details-panel empty" id="details">
			<span>Select a changeset to view details</span>
		</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const timeline = document.getElementById('timeline');
		const detailsPanel = document.getElementById('details');
		const timelineScroll = document.getElementById('timeline-scroll');
		const resizer = document.getElementById('resizer');
		let currentChanges = [];
		let selectedId = null;
		let branchLanes = {};
		let nextLane = 0;

		// Resizer logic
		let isResizing = false;
		let startY = 0;
		let startHeight = 200;

		resizer.addEventListener('mousedown', (e) => {
			isResizing = true;
			startY = e.clientY;
			startHeight = detailsPanel.offsetHeight;
			e.preventDefault();
		});

		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const delta = startY - e.clientY;
			const newHeight = Math.max(100, Math.min(400, startHeight + delta));
			detailsPanel.style.height = newHeight + 'px';
		});

		document.addEventListener('mouseup', () => {
			isResizing = false;
		});

		function hash(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h<<5)-h + s.charCodeAt(i); h|=0;} return Math.abs(h); }
		function colorFor(branch){ if(!branch) return '#3794ff'; const h = hash(branch)%360; return 'hsl(' + h + ', 70%, 60%)'; }

		function getLaneForBranch(branch) {
			if (!branch) branch = '/main';
			if (branchLanes[branch] === undefined) {
				branchLanes[branch] = nextLane++;
			}
			return branchLanes[branch];
		}

		function showDetails(changeset) {
			if (!changeset) {
				detailsPanel.className = 'details-panel empty';
				detailsPanel.innerHTML = '<span>Select a changeset to view details</span>';
				return;
			}
			detailsPanel.className = 'details-panel';
			detailsPanel.innerHTML =
				'<div class="detail-row"><div class="detail-label">Changeset</div><div class="detail-value">cs:' + (changeset.id || 'N/A') + '</div></div>' +
				'<div class="detail-row"><div class="detail-label">Author</div><div class="detail-value">' + (changeset.author || 'Unknown') + '</div></div>' +
				'<div class="detail-row"><div class="detail-label">Date</div><div class="detail-value">' + (changeset.dateIso || changeset.date || 'N/A') + '</div></div>' +
				'<div class="detail-row"><div class="detail-label">Branch</div><div class="detail-value">' + (changeset.branch || 'N/A') + '</div></div>' +
				'<div class="detail-row"><div class="detail-label">Repository</div><div class="detail-value">' + (changeset.repository || 'N/A') + '</div></div>' +
				'<div class="detail-row"><div class="detail-label">Comment</div><div class="detail-value detail-comment">' + (changeset.comment || 'No comment') + '</div></div>';
		}

		function selectEntry(id) {
			selectedId = id;
			const allEntries = timeline.querySelectorAll('.entry');
			allEntries.forEach(function(el) {
				el.classList.remove('selected');
			});
			const selected = timeline.querySelector('[data-id="' + id + '"]');
			if (selected) {
				selected.classList.add('selected');
			}
			const changeset = currentChanges.find(function(c) { return c.id == id; });
			showDetails(changeset);
		}

		const render = (changes) => {
			currentChanges = changes || [];
			selectedId = null;
			branchLanes = {};
			nextLane = 0;

			if (!Array.isArray(changes) || changes.length === 0) {
				timeline.innerHTML = '<div class="muted" style="text-align:center;padding:20px;">No data</div>';
				showDetails(null);
				return;
			}

			// Pre-assign lanes
			changes.forEach(function(e) {
				getLaneForBranch(e.branch);
			});

			const laneWidth = 20;
			const dotRadius = 7;

			timeline.innerHTML = changes.map(function(e, idx) {
				var lane = getLaneForBranch(e.branch);
				var dotColor = colorFor(e.branch);
				var dotX = lane * laneWidth + dotRadius;
				var nextEntry = changes[idx + 1];
				var prevEntry = idx > 0 ? changes[idx - 1] : null;

				// Build SVG for graph lines
				var svgHeight = 48;
				var svgLines = '';

				// Vertical line down to next commit
				if (nextEntry) {
					var nextLane = getLaneForBranch(nextEntry.branch);
					var nextX = nextLane * laneWidth + dotRadius;
					var lineColor = colorFor(e.branch);

					if (lane === nextLane) {
						// Straight line down
						svgLines += '<line x1="' + dotX + '" y1="' + (dotRadius * 2 + 4) + '" x2="' + dotX + '" y2="' + svgHeight + '" stroke="' + lineColor + '" stroke-width="2"/>';
					} else {
						// Branching/merging line
						var midY = svgHeight / 2;
						svgLines += '<path d="M ' + dotX + ' ' + (dotRadius * 2 + 4) + ' L ' + dotX + ' ' + midY + ' L ' + nextX + ' ' + svgHeight + '" stroke="' + lineColor + '" stroke-width="2" fill="none"/>';
					}
				}

				// Merge line from previous if branch changed
				if (prevEntry && prevEntry.branch !== e.branch) {
					var prevLane = getLaneForBranch(prevEntry.branch);
					var prevX = prevLane * laneWidth + dotRadius;
					var mergeColor = colorFor(prevEntry.branch);
					svgLines += '<path d="M ' + prevX + ' 0 L ' + prevX + ' 8 L ' + dotX + ' ' + (dotRadius * 2) + '" stroke="' + mergeColor + '" stroke-width="2" fill="none" opacity="0.6"/>';
				}

				return '<div class="entry" data-id="' + (e.id || idx) + '">' +
					'<div class="graph-cell">' +
						'<svg class="graph-canvas" width="' + (nextLane * laneWidth + 40) + '" height="' + svgHeight + '">' +
							svgLines +
						'</svg>' +
						'<div class="dot" style="background:' + dotColor + '; left:' + (dotX - dotRadius) + 'px;"></div>' +
					'</div>' +
					'<div class="card">' +
						'<div class="card-header">' +
							'<span class="cs-id">cs:' + (e.id || '') + '</span>' +
							'<span class="author">' + (e.author || '') + '</span>' +
						'</div>' +
						'<div class="branch-tag">' + (e.branch || '/main') + '</div>' +
						'<div class="card-comment">' + (e.comment || '') + '</div>' +
					'</div>' +
				'</div>';
			}).join('');

			// Attach click handlers
			const entries = timeline.querySelectorAll('.entry');
			entries.forEach(function(el) {
				el.addEventListener('click', function() {
					const id = el.getAttribute('data-id');
					selectEntry(id);
				});
			});
		};

		function demoChanges(){
			const now = Date.now();
			const mk = (i, br, mins, who, msg) => ({
				id: i,
				branch: br,
				author: who,
				comment: msg,
				dateIso: new Date(now - mins*60000).toISOString(),
				repository: 'demo-repo'
			});
			return [
				mk(120,'/main',5,'you','Merge feature/login'),
				mk(119,'/feature/login',12,'alice','Add OAuth flow'),
				mk(118,'/feature/login',18,'alice','UI polish'),
				mk(117,'/bugfix/audio-pop',25,'bob','Fix audio pop on scene load'),
				mk(116,'/main',35,'you','Bump version and changelog'),
				mk(115,'/feature/ai-assist',45,'carol','Agent hint hovercards'),
				mk(114,'/feature/ai-assist',52,'carol','Initial scaffolding'),
				mk(113,'/main',60,'you','Refactor input system'),
				mk(112,'/main',75,'you','Remove legacy shaders')
			];
		}

		window.addEventListener('message', (event) => {
			const msg = event.data || {};
			if (msg.type === 'data') {
				vscode.postMessage({ type: 'ui/log', message: 'received data: ' + (Array.isArray(msg.changes) ? msg.changes.length : 0) });
				render(msg.changes);
			}
		});

		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ type: 'ui/log', message: 'refresh clicked' });
			vscode.postMessage({ type: 'refresh' });
		});

		document.getElementById('preview').addEventListener('click', () => {
			vscode.postMessage({ type: 'ui/log', message: 'preview clicked' });
			const demo = demoChanges();
			render(demo);
			vscode.postMessage({ type: 'ui/log', message: 'rendered preview entries: ' + demo.length });
		});

		document.getElementById('order').addEventListener('click', () => {
			vscode.postMessage({ type: 'ui/log', message: 'order toggle clicked' });
			vscode.postMessage({ type: 'toggleOrder' });
			const btn = document.getElementById('order');
			if (btn) {
				const txt = btn.textContent || '';
				btn.textContent = txt.includes('Newest') ? 'Order: Oldest First' : 'Order: Newest First';
			}
		});

		document.getElementById('vcs-select').addEventListener('change', (e) => {
			const vcs = e.target.value;
			vscode.postMessage({ type: 'ui/log', message: 'VCS changed to: ' + vcs });
			vscode.postMessage({ type: 'vcsChanged', vcs: vcs });
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
    }

    private renderPlaceholderEntries(): string { return ''; }

    private fetchAndPost(webview: vscode.Webview): void {
        const cfg = vscode.workspace.getConfiguration();
        const itemsPerPage = cfg.get<number>('unityCursorToolkit.plasticTimeline.itemsPerPage') || 100;
        const source = (cfg.get<string>('unityCursorToolkit.plasticTimeline.source') as 'cli' | 'rest' | 'auto') || 'cli';
        const options: ListChangesetsOptions = { itemsPerPage, order: this.currentOrder };
        const fetchers: Array<() => Promise<any[]>> = [];
		uiChannel().appendLine(`[UI] fetch start: source=${source}, order=${this.currentOrder}, items=${itemsPerPage}`);
        if (source === 'cli') fetchers.push(() => listChangesetsCli(options));
        if (source === 'rest') fetchers.push(() => listChangesetsRest(options));
        if (source === 'auto') {
            fetchers.push(() => listChangesetsCli(options));
            fetchers.push(() => listChangesetsRest(options));
        }
        (async () => {
            for (const f of fetchers) {
                try {
                    const changes = await f();
                    if (Array.isArray(changes) && changes.length > 0) {
						uiChannel().appendLine(`[UI] fetch ok: ${changes.length} items`);
                        webview.postMessage({ type: 'data', changes });
                        return;
                    }
				} catch (e: any) {
					uiChannel().appendLine(`[UI] fetcher error: ${e?.message ?? e}`);
				}
            }
            // If nothing returned data, post empty
			uiChannel().appendLine('[UI] fetch completed: no data');
            webview.postMessage({ type: 'data', changes: [] });
        })();
    }
}


