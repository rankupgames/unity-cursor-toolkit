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
 await test('focus validates the owner twice, foregrounds only its PID and verifies in a fresh process', async () => {
  const calls = [];
  const result = await focusUnityEditor(root, { platform: 'darwin', readVersion: () => 'm_EditorVersion: 6000.3.9f1\n', run: async (command, args) => {
   calls.push({ command, args });
   if (command.endsWith('/lsof')) return '101\n';
   if (command.endsWith('/ps')) return '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity\n';
   assert.strictEqual(command, '/usr/bin/osascript');
   const script = args.join(' ');
   assert.ok(script.includes('pid=101') && script.includes("name()!=='Unity'"));
   if (script.includes('frontmost=true')) return ''; // Activation is not foreground proof.
   assert.ok(script.includes('String(matches[0].frontmost())'));
   return 'true\n';
  } });
  assert.strictEqual(result.state, 'activated');
  assert.deepStrictEqual(calls.map(c => path.basename(c.command)), ['lsof', 'ps', 'lsof', 'osascript', 'osascript']);
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
   assert.strictEqual(command, '/usr/bin/osascript');
   return args.join(' ').includes('frontmost=true') ? 'true' : 'false'; // Activation output is not proof.
  };
  const result = await focusUnityEditor(root, { platform: 'darwin', run, readVersion: () => 'm_EditorVersion: 6000.3.9f1\n' });
  assert.strictEqual(result.state, 'not_foreground');
  assert.strictEqual(calls.filter(call => call.command.endsWith('/open')).length, 0);
  assert.strictEqual(calls.filter(call => call.command.endsWith('/osascript')).length, 2);
  const count = calls.length;
  assert.strictEqual((await focusUnityEditor(root, { platform: 'linux', run })).state, 'unsupported');
  assert.strictEqual(calls.length, count);
 });
 for (const defect of ['activation-failure', 'verification-failure', 'invalid-verification']) await test('focus rejects ' + defect, async () => {
  const calls = [];
  const result = await focusUnityEditor(root, { platform: 'darwin', readVersion: () => 'm_EditorVersion: 6000.3.9f1\n', run: async (command, args) => {
   calls.push({ command, args });
   if (command.endsWith('/lsof')) return '101';
   if (command.endsWith('/ps')) return '/fixture/6000.3.9f1/Unity.app/Contents/MacOS/Unity';
   assert.strictEqual(command, '/usr/bin/osascript');
   if (args.join(' ').includes('frontmost=true')) {
    if (defect === 'activation-failure') { const error = new Error('fixture activation rejected'); error.code = 1; throw error; }
    return '';
   }
   if (defect === 'verification-failure') { const error = new Error('fixture fresh verification timed out'); error.code = 'ETIMEDOUT'; throw error; }
   return 'not-a-process-state';
  } });
  assert.strictEqual(result.state, 'failed');
  assert.strictEqual(calls.filter(call => call.command.endsWith('/osascript')).length, defect === 'activation-failure' ? 1 : 2);
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
 await test('saved compiler failures stop only the active compile request', async () => {
  const now = Date.now();
  let reads = 0;
  let recorded = { ...project, requestId: 'earlier', capturedUtc: new Date(now).toISOString(), status: 'failed', errorCount: 1 };
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async () => { reads++; return null; } },
   { projectRoot: root, automatic: false, now: () => now, readValidation: () => recorded });
  monitor.observe('project_info', project);
  monitor.recover('compile_pending', 'current');
  assert.strictEqual((await monitor.poll()).state, 'waiting');
  assert.strictEqual(reads, 1);
  recorded = { ...recorded, requestId: 'current' };
  assert.strictEqual((await monitor.poll()).state, 'compile_failed');
  assert.strictEqual(reads, 1, 'Matching compiler failures stop without waiting for the Editor');
  monitor.dispose();
 });
 await test('saved diagnostics show progress during a bridge stall and need live completion', async () => {
  const now = Date.now();
  let responding = false;
  const recorded = { ...project, requestId: 'current', capturedUtc: new Date(now).toISOString(),
   compilationStarted: true, compilationFinished: true, diagnosticsComplete: true, errorCount: 0,
   status: 'succeeded', pending: false, compileSucceeded: true, success: true };
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async (_, args) =>
   responding ? { result: args.toolName === 'project_info' ? project : recorded } : null },
   { projectRoot: root, automatic: false, now: () => now, readValidation: () => recorded });
  monitor.observe('project_info', project);
  monitor.recover('compile_pending', 'current');
  const waiting = await monitor.poll();
  assert.strictEqual(waiting.state, 'waiting_for_main_thread');
  assert(waiting.pending);
  assert.strictEqual(waiting.compileSucceeded, false);
  assert.strictEqual(waiting.success, false);
  assert.strictEqual(waiting.bridgeRecovered, false);
  responding = true;
  assert.strictEqual((await monitor.poll()).state, 'compiled');
  monitor.dispose();
 });
 await test('a new compile replaces the active request and ignores its old poll', async () => {
  let now = Date.now();
  let recorded;
  let completeOldProbe;
  const calls = [];
  const monitor = new EditorRecoveryMonitor({ send() {}, request: (_, args) => {
   calls.push(args.toolName);
   if (args.toolName !== 'project_info') return Promise.resolve(null);
   return new Promise(resolve => { completeOldProbe = resolve; });
  } }, { projectRoot: root, automatic: false, now: () => now, readValidation: () => recorded });
  monitor.observe('project_info', project);
  monitor.observe('editor_validation', { ...project, requestId: 'a', requestedUtc: new Date(now).toISOString(), pending: true });
  const oldPoll = monitor.poll();
  now += 1000;
  monitor.observe('editor_validation', { ...project, projectPath: root + '-other', requestId: 'foreign', pending: true });
  assert.strictEqual(monitor.status.requestId, 'a');
  monitor.observe('editor_validation', { ...project, requestId: 'b', requestedUtc: new Date(now).toISOString(), pending: true });
  monitor.observe('editor_validation', { ...project, requestId: 'a', requestedUtc: new Date(now - 1000).toISOString(), pending: true });
  completeOldProbe({ result: project });
  const current = await oldPoll;
  assert.strictEqual(current.requestId, 'b');
  assert.strictEqual(current.bridgeRecovered, false);
  recorded = { ...project, requestId: 'b', capturedUtc: new Date(now).toISOString(), status: 'failed', errorCount: 1 };
  assert.strictEqual((await monitor.poll()).state, 'compile_failed');
  assert.deepStrictEqual(calls, ['project_info']);
  monitor.dispose();
 });
 await test('a late observer accepts saved diagnostics from the selected request start', async () => {
  const now = Date.now();
  const requestedUtc = new Date(now - 5000).toISOString();
  let recorded = { ...project, requestId: 'current', capturedUtc: new Date(now - 6000).toISOString(),
   compilationStarted: true, compilationFinished: true, diagnosticsComplete: true, errorCount: 0 };
  const monitor = new EditorRecoveryMonitor({ send() {}, request: async () => null },
   { projectRoot: root, automatic: false, now: () => now, readValidation: () => recorded });
  monitor.observe('editor_validation', { ...project, requestId: 'current', requestedUtc, pending: true });
  assert.strictEqual((await monitor.poll()).state, 'waiting');
  recorded = { ...recorded, capturedUtc: new Date(now - 2000).toISOString() };
  const pending = await monitor.poll();
  assert.strictEqual(pending.state, 'waiting_for_main_thread');
  assert.strictEqual(pending.compileSucceeded, false);
  monitor.dispose();
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
