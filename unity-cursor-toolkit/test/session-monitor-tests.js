/** Event-driven file journal and real MCP lifecycle notification boundaries. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionJournalWatcher } = require('../out/mcp/sessionJournal');
const { createStandaloneMcpRuntime } = require('../out/mcp/server');
const { isMutatingToolCall } = require('../out/mcp/toolMetadata');
let passed = 0;
const cleanups = [];
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
function event(sequence, kind = 'session_started') { return { version: 1, sequence, sessionId: 'play_fixture', kind, occurredUtc: '2026-01-01T00:00:00Z', frame: 1 }; }
function signal() {
 let resolve, reject;
 const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
 const timer = setTimeout(() => reject(new Error('The expected filesystem notification was not received.')), 3000);
 cleanups.push(() => { clearTimeout(timer); resolve(); });
 return { promise, resolve: value => { clearTimeout(timer); resolve(value); } };
}
async function main() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-session-fixture-'));
 cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
 const dir = path.join(root, 'Library/UnityCursorToolkit/PlaySessions'); fs.mkdirSync(dir, { recursive: true });
 const file = path.join(dir, 'events.jsonl');
 await test('watcher preserves order and reports event gaps without mutating the journal', async () => {
  fs.writeFileSync(file, JSON.stringify(event(1)) + '\n'); const events = []; const done = signal();
  const watcher = new SessionJournalWatcher(root, item => { events.push(item); if (item.sequence === 3) done.resolve(); });
  cleanups.push(() => watcher.dispose());
  assert.strictEqual(watcher.start(0).success, true);
  fs.appendFileSync(file, JSON.stringify(event(3, 'session_ended')) + '\n');
  await done.promise; watcher.dispose();
  assert.deepStrictEqual(events.map(x => x.kind), ['session_started', 'event_gap', 'session_ended']);
  assert.strictEqual(events[1].expectedSequence, 2); assert.strictEqual(events[1].observedSequence, 3);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
 });
 await test('watcher rejects malformed events and stops instead of accepting partial evidence', async () => {
  fs.writeFileSync(file, '{"version":1,"sequence":1}\n'); const done = signal();
  const watcher = new SessionJournalWatcher(root, item => { if (item.kind === 'watch_error') done.resolve(item); });
  cleanups.push(() => watcher.dispose());
  watcher.start(0); const failure = await done.promise;
  assert.strictEqual(failure.error, 'journal_invalid_event'); assert.strictEqual(watcher.status.watching, false); watcher.dispose();
 });
 await test('watch starts at the current end and receives later session events', async () => {
  fs.writeFileSync(file, JSON.stringify(event(1)) + '\n'); const received = []; const done = signal();
  const watcher = new SessionJournalWatcher(root, item => { received.push(item); if (item.sequence === 2) done.resolve(); });
  cleanups.push(() => watcher.dispose());
  watcher.start(); fs.appendFileSync(file, JSON.stringify(event(2, 'error_observed')) + '\n'); await done.promise;
  watcher.dispose(); assert.deepStrictEqual(received.map(x => x.sequence), [2]);
 });
 await test('MCP initialized/subscribed client receives standard lifecycle and resource notifications', async () => {
  fs.writeFileSync(file, ''); const previous = process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH;
  process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = root;
  const runtime = createStandaloneMcpRuntime(true);
  cleanups.push(() => { runtime.dispose(); if (previous === undefined) delete process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH; else process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = previous; });
  const notifications = []; const done = signal();
  runtime.onNotification(item => { notifications.push(item); if (item.method === 'notifications/resources/updated') done.resolve(); });
  await runtime.handleRequest({ method: 'initialize', params: {} });
  await runtime.handleRequest({ method: 'notifications/initialized' });
  await runtime.handleRequest({ method: 'resources/subscribe', params: { uri: 'unity://sessions/events' } });
  fs.appendFileSync(file, JSON.stringify(event(1, 'session_ended')) + '\n'); await done.promise;
  runtime.dispose();
  if (previous === undefined) delete process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH; else process.env.UNITY_CURSOR_TOOLKIT_PROJECT_PATH = previous;
  const log = notifications.find(item => item.method === 'notifications/message');
  assert.strictEqual(log.params.data.kind, 'session_ended'); assert.strictEqual(log.params.logger, 'unity.play_session');
  assert.strictEqual(notifications.find(item => item.method === 'notifications/resources/updated').params.uri, 'unity://sessions/events');
 });
 await test('capture configuration is mutating while evidence reads and subscriptions are read-only', async () => {
  for (const action of ['configure', 'capture', 'compact']) assert.strictEqual(isMutatingToolCall('session_monitor', { action }), true);
  for (const action of ['status', 'events', 'timeline', 'compare', 'read', 'watch', 'unwatch']) assert.strictEqual(isMutatingToolCall('session_monitor', { action }), false);
  assert.strictEqual(new SessionJournalWatcher(undefined, () => {}).start().success, false);
 });
 fs.rmSync(root, { recursive: true, force: true });
 console.log(`\n ${passed} passed, 0 failed, ${passed} total`);
}
main().then(() => { while (cleanups.length) cleanups.pop()(); }, error => { while (cleanups.length) cleanups.pop()(); console.error(error); process.exitCode = 1; });
