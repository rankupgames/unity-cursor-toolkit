import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

function getCliPath(): string {
    const configured = vscode.workspace.getConfiguration().get<string>('unityCursorToolkit.plasticTimeline.cliPath');
    const value = (configured && configured.length > 0) ? configured : 'cm';
    channel().appendLine(`[PlasticCLI] Using CLI: ${value}`);
    return value;
}

function getWorkspaceCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;

    // Prefer a folder that contains or is inside a Plastic workspace (has a .plastic dir up the tree)
    for (const f of folders) {
        const found = findWorkspaceRoot(f.uri.fsPath);
        if (found) return found;
    }
    // Fallback to the first folder
    return folders[0].uri.fsPath;
}

function findWorkspaceRoot(startPath: string): string | undefined {
    try {
        let current = startPath;
        const root = path.parse(current).root;
        while (true) {
            if (fs.existsSync(path.join(current, '.plastic'))) {
                return current;
            }
            if (current === root) {
                return undefined;
            }
            current = path.dirname(current);
        }
    } catch {
        return undefined;
    }
}

function macCliCandidates(): string[] {
    // Common macOS locations for Plastic/Unity Version Control CLI
    return [
        '/opt/homebrew/bin/cm',            // Apple Silicon Homebrew
        '/usr/local/bin/cm',               // Intel/Homebrew or installer
        '/usr/bin/cm',
        '/Applications/PlasticSCM.app/Contents/Tools/cm',
        '/Applications/Plastic SCM.app/Contents/Tools/cm',
        '/Applications/Unity Version Control.app/Contents/Tools/cm'
    ];
}

function windowsCliCandidates(): string[] {
    // Common Windows locations (adjust based on installed versions)
    return [
        'C:/Program Files/PlasticSCM5/client/cm.exe',
        'C:/Program Files/PlasticSCM/client/cm.exe',
        'C:/Program Files (x86)/PlasticSCM5/client/cm.exe',
        'C:/Program Files/Unity Version Control/cm.exe',
        'C:/Program Files/Unity/Unity Version Control/cm.exe'
    ];
}

export async function listChangesets(options: ListChangesetsOptions): Promise<ChangeSet[]> {
    const cli = getCliPath();
    const limitArg = String(options.itemsPerPage);

    const cwd = getWorkspaceCwd();

    // Use 'find changeset' for compatibility (older CLIs don't support --limit on log/find)
    const findArgs = [
        'find',
        'changeset',
        'where',
        'changesetid > 0',
        `--format={changesetid}|{owner}|{date}|{branch}|{repository}|{comment}`,
        '--nototal'
    ];
    channel().appendLine(`[PlasticCLI] cwd: ${cwd ?? '(none)'}; running: ${cli} ${findArgs.join(' ')} (using find)`);
    const findOut = await run(cli, findArgs, cwd);
    let parsed: ChangeSet[] = parseFind(findOut);

    // Note preferXml: retained for future, but we keep 'find' as the source to avoid huge XML outputs on older CLIs
    const preferXml = !!vscode.workspace.getConfiguration().get<boolean>('unityCursorToolkit.plasticTimeline.preferXml');
    if (preferXml) {
        channel().appendLine('[PlasticCLI] preferXml enabled; using find-based parsing for compatibility.');
    }

    // Sort newest-first by numeric changeset id to emulate order and then apply client-side limit
    const toIdNum = (id: string) => {
        const m = id.match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    };
    parsed.sort((a, b) => toIdNum(b.id) - toIdNum(a.id));

    if (options.order === 'oldest-first') {
        parsed.reverse();
    }

    if (parsed.length > options.itemsPerPage) {
        parsed = parsed.slice(0, options.itemsPerPage);
    }

    channel().appendLine(`[PlasticCLI] Parsed changesets: ${parsed.length} (client-limited to ${options.itemsPerPage})`);
    if (parsed.length === 0) {
        channel().appendLine('[PlasticCLI] No changesets parsed.');
    }
    return parsed;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve) => {
        const tryExec = (commandPath: string, onFail?: () => void) => {
            execFile(commandPath, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
                if (err) {
                    // If ENOENT on macOS, try common install locations
                    const enoent = (err as any)?.code === 'ENOENT' || /ENOENT|spawn .* ENOENT/i.test(err.message);
                    if (enoent && process.platform === 'darwin' && onFail) {
                        return onFail();
                    }
                    channel().appendLine(`[PlasticCLI] ERROR: ${err.message}`);
                }
                if (stderr && stderr.trim().length > 0) {
                    channel().appendLine(`[PlasticCLI] stderr: ${stderr.trim().slice(0, 500)}`);
                }
                resolve(stdout || '');
            });
        };

        // First attempt: provided command as-is (e.g., 'cm' or configured path)
        tryExec(cmd, () => {
            // Platform-specific fallback search
            let candidates: string[] = [];
            let label: string = process.platform;
            if (process.platform === 'darwin') {
                candidates = macCliCandidates();
                label = 'macOS';
            } else if (process.platform === 'win32') {
                candidates = windowsCliCandidates();
                label = 'Windows';
            }

            candidates = candidates.filter(p => {
                try { return fs.existsSync(p); } catch { return false; }
            });

            if (candidates.length === 0) {
                channel().appendLine(`[PlasticCLI] Could not locate cm on ${label}. Set unityCursorToolkit.plasticTimeline.cliPath.`);
                return resolve('');
            }
            const chosen = candidates[0];
            channel().appendLine(`[PlasticCLI] Retrying with detected ${label} CLI path: ${chosen}`);
            tryExec(chosen);
        });
    });
}

function parseSimple(stdout: string): ChangeSet[] {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const results: ChangeSet[] = [];
    for (const line of lines) {
        // Try a few heuristics, CLI output varies by version and server config
        // Pattern A: "cs:1234 by user on 2025-10-30 12:34:56: Commit message"
        let match = line.match(/^(?:cs:)?(\d+)\s+by\s+([^\s]+).*?\s(\d{4}-\d{2}-\d{2}[^:]*?:?)\s*:?\s*(.*)$/i);
        if (match) {
            results.push({ id: `cs:${match[1]}`, author: match[2], dateIso: match[3], comment: match[4] });
            continue;
        }
        // Pattern B: "changeset 1234 user 2025-10-30T12:34:56Z comment..."
        match = line.match(/^.*?(?:changeset\s*)?(\d+)\s+([\w.-]+)\s+(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/i);
        if (match) {
            results.push({ id: `cs:${match[1]}`, author: match[2], dateIso: match[3], comment: match[4] });
            continue;
        }
    }
    return results;
}

function parseXml(xml: string): ChangeSet[] {
    if (!xml || xml.trim().length === 0) return [];
    const results: ChangeSet[] = [];
    try {
        // Very lightweight parsing to avoid external deps
        // Try to split by <changeset ...> blocks
        const blocks = xml.split(/<changeset[\s>]/i).slice(1);
        for (const block of blocks) {
            const seg = '<changeset ' + block; // reconstruct minimal
            const idMatch = seg.match(/<id>([^<]+)<\/id>/i) || seg.match(/\bchangesetid=\"?(\d+)\"?/i);
            const authorMatch = seg.match(/<owner>([^<]+)<\/owner>/i) || seg.match(/<author>([^<]+)<\/author>/i);
            const dateMatch = seg.match(/<date>([^<]+)<\/date>/i) || seg.match(/<creationdate>([^<]+)<\/creationdate>/i);
            const commentMatch = seg.match(/<comment>([\s\S]*?)<\/comment>/i);
            const branchMatch = seg.match(/<branch>([^<]+)<\/branch>/i);
            const repoMatch = seg.match(/<repository>([^<]+)<\/repository>/i);

            const id = idMatch ? `cs:${idMatch[1]}` : '';
            const author = authorMatch ? authorMatch[1] : '';
            const dateIso = dateMatch ? dateMatch[1] : '';
            const comment = commentMatch ? commentMatch[1].trim() : '';
            const branch = branchMatch ? branchMatch[1] : undefined;
            const repository = repoMatch ? repoMatch[1] : undefined;
            if (id) {
                results.push({ id, author, dateIso, comment, branch, repository });
            }
        }
    } catch (e: any) {
        channel().appendLine(`[PlasticCLI] XML parse error: ${e.message || String(e)}`);
        return [];
    }
    return results;
}

function parseFind(stdout: string): ChangeSet[] {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const results: ChangeSet[] = [];
    for (const line of lines) {
        // Expect: id|owner|date|branch|repository|comment (comment may contain additional '|')
        const parts = line.split('|');
        if (parts.length < 6) {
            continue;
        }
        const idRaw = parts[0];
        const owner = parts[1];
        const dateIso = parts[2];
        const branch = parts[3] || undefined;
        const repository = parts[4] || undefined;
        const comment = parts.slice(5).join('|');
        const id = idRaw.startsWith('cs:') ? idRaw : `cs:${idRaw}`;
        results.push({ id, author: owner, dateIso, comment, branch, repository });
    }
    return results;
}


