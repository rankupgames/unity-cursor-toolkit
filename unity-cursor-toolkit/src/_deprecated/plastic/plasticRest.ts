// @ts-nocheck
/**
 * [WIP] Plastic SCM REST API client -- scaffold for future REST-based timeline data.
 * Currently disconnected from the extension. Not registered or activated.
 * Re-enable by wiring into extension.ts and package.json when ready.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as vscode from 'vscode';

export type TimelineOrder = 'newest-first' | 'oldest-first';

export interface ChangeSet {
    id: string;
    author: string;
    dateIso: string;
    comment: string;
    branch?: string;
    repository?: string;
}

export interface ListChangesetsOptions {
    itemsPerPage: number;
    order: TimelineOrder;
}

let _channel: vscode.OutputChannel | undefined;
function channel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('Unity Cursor: Plastic Timeline');
    }
    return _channel;
}

// Placeholder REST scaffold; returns empty data for now
export async function listChangesets(options: ListChangesetsOptions): Promise<ChangeSet[]> {
    channel().appendLine(`[PlasticREST] REST client scaffold active. ItemsPerPage=${options.itemsPerPage}, Order=${options.order}`);
    // TODO: Implement Plastic REST calls (Phase 2)
    return [];
}


