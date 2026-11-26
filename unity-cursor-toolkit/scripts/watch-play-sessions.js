#!/usr/bin/env node
/** Standby diagnostics stream using the same event-driven journal reader as MCP. */
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
 const args = process.argv.slice(2);
 if (args.length !== 2 || args[0] !== '--project' || !args[1]) throw new Error('Usage: --project <Unity project root>');
 const { SessionJournalWatcher } = await import(pathToFileURL(path.join(__dirname, '../src/mcp/sessionJournal.ts')).href);
 const watcher = new SessionJournalWatcher(args[1], event => process.stdout.write(JSON.stringify(event) + '\n'));
 const result = watcher.start(); process.stdout.write(JSON.stringify({ kind: 'watch_status', ...result }) + '\n');
 process.on('SIGINT', () => { watcher.dispose(); process.exit(0); });
 process.on('SIGTERM', () => { watcher.dispose(); process.exit(0); });
 if (!result.success) process.exitCode = 1;
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
