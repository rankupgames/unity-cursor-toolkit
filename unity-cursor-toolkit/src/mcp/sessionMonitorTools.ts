/** MCP session subscription plus relay to the Editor-owned capture subsystem. */
import type { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import type { SessionJournalWatcher } from './sessionJournal';
import { getToolAnnotations, withDryRunProperty } from './toolMetadata';

export class SessionMonitorTools implements IToolProvider {
 public readonly toolGroupName = 'session-monitor';
 private readonly relay: IToolProvider;
 private readonly watcher: SessionJournalWatcher;
 constructor(relay: IToolProvider, watcher: SessionJournalWatcher) { this.relay = relay; this.watcher = watcher; }
 public getTools(): ToolDefinition[] {
  return [{ name: 'session_monitor', title: 'Session Monitor',
   description: 'Opt in to Play start/error/end snapshots; read object/component evidence and watch lifecycle events. Candidates from a stack are not proven causes. Capture runs on the next safe Editor tick.',
   inputSchema: { type: 'object', properties: withDryRunProperty({
    action: { type: 'string', enum: ['status', 'configure', 'events', 'capture', 'read', 'timeline', 'compare', 'compact', 'watch', 'unwatch'] },
    enabled: { type: 'boolean' }, captureOnError: { type: 'boolean' },
    afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Events/timeline1..100; object reads/changes1..200.' },
    offset: { type: 'integer', minimum: 0 }, sessionId: { type: 'string' }, snapshotId: { type: 'string' }, otherSessionId: { type: 'string' }, otherSnapshotId: { type: 'string' }, reason: { type: 'string' }
   }) }, annotations: getToolAnnotations('session_monitor') }];
 }
 public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const action = args.action ?? 'status';
  if (action === 'watch' || action === 'unwatch') {
   if (Object.keys(args).some(key => !['action', 'afterSequence', 'dryRun'].includes(key)) ||
       (args.afterSequence != null && (!Number.isSafeInteger(args.afterSequence) || Number(args.afterSequence) < 0))) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'invalid_subscription_arguments' }) }] };
   }
   const result = action === 'watch' ? this.watcher.start(args.afterSequence as number | undefined) : this.watcher.stop();
   return { isError: result.success === false, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  return this.relay.handleToolCall(name, args);
 }
}
