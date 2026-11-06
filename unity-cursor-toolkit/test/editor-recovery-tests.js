/** Real boundary regressions for exact-project focus and independent recovery. Requires committed compile output. */
const assert = require('assert');
const path = require('path');
const { focusUnityEditor } = require('../out/core/unityEditorFocus');
const { EditorRecoveryMonitor } = require('../out/mcp/editorRecoveryMonitor');
const { UnityMcpTools } = require('../out/mcp/unityMcpTools');
let passed = 0;
async function test(name, action) { await action(); passed++; process.stdout.write('PASS ' + name + '\n'); }
const root = path.resolve('/fixture/unity-project');
const project = { projectPath: root, editorPid: 101 };
async function main() {
 await test('focus validates the owner twice, opens its verified bundle and verifies its PID in a fresh process', async () => {
  const calls = [];
  const result = await focusUnityEditor(root, { platform: 'darwin', readVersion: () => 'm_EditorVersion: 6000.3.9f1\n', run: async (command, args) => {
   calls.push({ command, args });
   if (command.endsWith('/lsof')) return '101\n';
   if (command.endsWith('/ps')) return '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity\n';
   if (command.endsWith('/open')) { assert.deepStrictEqual(args, ['-a', '/fixture/6000.3.9f1/Unity.app']); return ''; }
   assert.strictEqual(command, '/usr/bin/osascript');
   assert.ok(args.join(' ').includes('pid=101'));
   assert.ok(!args.join(' ').includes('frontmost=true'), 'Foreground proof must come from a fresh read, not the activation process.');
   return 'true\n';
  } });
  assert.strictEqual(result.state, 'activated');
  assert.deepStrictEqual(calls.map(c => path.basename(c.command)), ['lsof', 'ps', 'lsof', 'open', 'osascript']);
 });
 for (const [name, owners, executable, expected, expectedPid, unityPath] of [
  ['absent', '', '', 'not_running'], ['ambiguous', '101\n102', '', 'ambiguous'],
  ['wrong-install', '101', '/fixture/other/Unity', 'mismatch'], ['wrong-pid', '101', '', 'mismatch', 102],
  ['handover', '101', '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity', 'mismatch'],
  ['configured-other-bundle', '101', '/fixture/Other.app/Contents/MacOS/Unity', 'mismatch', undefined, '/fixture/Other.app/Contents/MacOS/Unity']
 ]) await test('focus rejects ' + name, async () => {
  let ownerReads = 0, activations = 0;
  const result = await focusUnityEditor(root, { platform: 'darwin', expectedPid, unityPath, readVersion: () => 'm_EditorVersion: 6000.3.9f1\n', run: async command => {
   if (command.endsWith('/lsof')) return name === 'handover' && ++ownerReads > 1 ? '102' : owners;
   if (command.endsWith('/ps')) return executable;
   activations++; return 'true';
  } });
  assert.strictEqual(result.state, expected); assert.strictEqual(activations, 0);
 });
 await test('focus ignores activation output and reports the fresh foreground result', async () => {
  const calls = [];
  const run = async (command, args) => {
   calls.push({ command, args });
   if (command.endsWith('/lsof')) return '101';
   if (command.endsWith('/ps')) return '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
   if (command.endsWith('/open')) return 'true'; // Successful activation output is not proof.
   assert.strictEqual(command, '/usr/bin/osascript');
   return 'false';
  };
  const result = await focusUnityEditor(root, { platform: 'darwin', run, readVersion: () => 'm_EditorVersion: 6000.3.9f1\n' });
  assert.strictEqual(result.state, 'not_foreground');
  assert.strictEqual(calls.filter(call => call.command.endsWith('/open')).length, 1);
  assert.strictEqual(calls.filter(call => call.command.endsWith('/osascript')).length, 1);
  const count = calls.length;
  assert.strictEqual((await focusUnityEditor(root, { platform: 'linux', run })).state, 'unsupported');
  assert.strictEqual(calls.length, count);
 });
 for (const defect of ['open-failure', 'verification-failure', 'invalid-verification']) await test('focus rejects ' + defect, async () => {
  const calls = [];
  const result = await focusUnityEditor(root, { platform: 'darwin', readVersion: () => 'm_EditorVersion: 6000.3.9f1\n', run: async (command, args) => {
   calls.push({ command, args });
   if (command.endsWith('/lsof')) return '101';
   if (command.endsWith('/ps')) return '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
   if (command.endsWith('/open')) {
    assert.deepStrictEqual(args, ['-a', '/fixture/6000.3.9f1/Unity.app']);
    if (defect === 'open-failure') { const error = new Error('fixture activation rejected'); error.code = 1; throw error; }
    return '';
   }
   if (defect === 'verification-failure') { const error = new Error('fixture fresh verification timed out'); error.code = 'ETIMEDOUT'; throw error; }
   return 'not-a-process-state';
  } });
  assert.strictEqual(result.state, 'failed');
  assert.strictEqual(calls.filter(call => call.command.endsWith('/osascript')).length, defect === 'open-failure' ? 0 : 1);
 });
 await test('recovery is bounded, never replays a command and needs a fresh selected-project response', async () => {
  let now = 0, responding = false, focuses = 0; const calls = [];
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async (_, args) => { calls.push(args.toolName); return responding ? { result: project } : null; } },
   { projectRoot: root, automatic: false, now: () => now, readValidation: () => undefined, focusEditor: async () => { focuses++; return { state: 'activated', pid: 101, reason: 'fixture' }; } });
  await monitor.poll(); assert.strictEqual(calls.length, 0);
  monitor.recover(); now = 4000; await monitor.poll(); assert.strictEqual(focuses, 0);
  for (now of [6000, 12000, 17000, 28000]) await monitor.poll();
  assert.strictEqual(focuses, 2); assert.strictEqual(monitor.status.pending, true);
  responding = true; await monitor.poll();
  assert.strictEqual(monitor.status.state, 'recovered'); assert.strictEqual(monitor.status.success, false); assert.strictEqual(monitor.status.compileSucceeded, false);
  assert.ok(calls.every(name => name === 'project_info')); monitor.dispose();
 });
 await test('compile completion is bound to the exact request and successful evidence', async () => {
  let validation = { ...project, requestId: 'different', pending: false, success: true, compileSucceeded: true };
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async (_, args) => ({ result: args.toolName === 'project_info' ? project : validation }) },
   { projectRoot: root, automatic: false, readValidation: () => undefined });
  monitor.recover('compile_pending', 'fixture-request'); await monitor.poll(); assert.strictEqual(monitor.status.pending, true);
  validation = { ...validation, requestId: 'fixture-request', pending: true, success: false }; await monitor.poll(); assert.strictEqual(monitor.status.pending, true);
  validation = { ...validation, pending: false, success: true }; await monitor.poll(); assert.strictEqual(monitor.status.state, 'compiled'); assert.strictEqual(monitor.status.success, true); monitor.dispose();
 });
 for (const defect of ['compiler-error', 'project-mismatch', 'deadline', 'disposed']) await test('recovery stops on ' + defect, async () => {
  let now = 0, focuses = 0;
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async () => defect === 'project-mismatch' ? { result: { projectPath: root + '-other' } } : null },
   { projectRoot: root, automatic: false, now: () => now,
    readValidation: () => defect === 'compiler-error' ? { ...project, capturedUtc: new Date(now).toISOString(), status: 'failed', errorCount: 1 } : undefined,
    focusEditor: async () => { focuses++; return { state: 'activated', reason: 'fixture' }; } });
  monitor.recover(); if (defect === 'disposed') monitor.dispose(); now = defect === 'deadline' ? 60000 : 6000; await monitor.poll();
  assert.strictEqual(focuses, 0); assert.notStrictEqual(monitor.status.state, 'compiled');
  if (defect !== 'disposed') assert.strictEqual(monitor.status.pending, false); monitor.dispose();
 });
 await test('Unity JSON-string failures remain tool failures', async () => {
  const tools = new UnityMcpTools({ send() {}, request: async () => ({ result: JSON.stringify({ success: false, error: 'fixture_failure' }) }) });
  assert.strictEqual((await tools.handleToolCall('game_command', { action: 'status', runId: 'fixture' })).isError, true);
 });
 console.log(`\n ${passed} passed, 0 failed, ${passed} total`);
}
main().then(() => {}, error => { console.error(error); process.exitCode = 1; });
