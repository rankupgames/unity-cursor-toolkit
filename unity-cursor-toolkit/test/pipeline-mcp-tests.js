'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PipelineMcpTools, PIPELINE_COMMAND_NAMES } = require('../out/mcp/pipelineMcpTools');
const { PipelineAudit } = require('../out/core/pipelineAudit');
const { ToolRouter } = require('../out/mcp/toolRouter');
const policy = require('../out/core/pipelinePolicy.json');
let passed = 0, failed = 0;
const packageId = 'com.unity.pipeline';
const version = '6000.3.9f1', pid = 731;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const payload = result => JSON.parse(result.content[0].text);
const events = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const ok = data => ({ ok: true, data, warnings: [], exitCode: 0, signal: null, stdout: '', stderr: '' });
const parameter = { name: 'path', type: 'string', description: 'Confined text path.', required: true, default: null };
const tool = name => ({ name, description: 'Native description.', group: 'built-in', parameters: [{ ...parameter }] });
async function test(name, run) {
 try { await run(); passed++; console.log('PASS ' + name); }
 catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
async function fixture(run) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-pipeline-provider-'));
 const projectPath = path.join(root, 'project'), auditPath = path.join(root, 'audit.jsonl');
 const packagePath = path.join(projectPath, 'Library', 'PackageCache', packageId + '@reviewed');
 for (const directory of ['Assets', 'ProjectSettings', 'Packages']) fs.mkdirSync(path.join(projectPath, directory), { recursive: true });
 fs.mkdirSync(packagePath, { recursive: true });
 fs.mkdirSync(path.join(root, 'project-sibling'));
 fs.writeFileSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
 json(path.join(projectPath, 'Packages', 'manifest.json'), { dependencies: { [packageId]: policy.pipelineVersion } });
 json(path.join(projectPath, 'Packages', 'packages-lock.json'), { dependencies: { [packageId]: { version: policy.pipelineVersion, depth: 0, source: 'registry', url: 'https://packages.unity.com' } } });
 json(path.join(packagePath, 'package.json'), { name: packageId, version: policy.pipelineVersion });
 const calls = [], request = { action: 'list', projectPath, editorPid: pid, timeoutMs: 3000 };
 const status = () => ({ count: 1, instances: [{ project: projectPath, version, pid, state: 'ready', port: 7800 }] });
 const listing = () => ({ target: { host: '127.0.0.1', port: 7800 }, count: 3, tools: [tool('read_text_file'), tool('custom_read'), tool('proof_delay')] });
 const adapter = {
  probe: async options => { calls.push({ command: 'probe', options }); assert.equal(events(auditPath)[0].outcome, 'started'); return ok({ version: policy.cliVersion, expectedVersion: policy.cliVersion }); },
  invoke: async (command, args, options) => { calls.push({ command, args, options }); assert.equal(events(auditPath)[0].outcome, 'started'); return ok(command === 'status' ? status() : listing()); }
 };
 const audit = new PipelineAudit(auditPath, PIPELINE_COMMAND_NAMES);
 const provider = new PipelineMcpTools(adapter, audit);
 try { await run({ root, projectPath, packagePath, auditPath, request, status, listing, calls, adapter, audit, provider }); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function main() {
 await test('approved schema exposes only discovery and refused run with required exact target', async () => fixture(async f => {
  const definition = f.provider.getTools()[0];
  assert.equal(definition.name, 'commands'); assert.equal(definition.annotations.readOnlyHint, true);
  assert.deepStrictEqual(Object.keys(definition.inputSchema.properties), ['action', 'projectPath', 'editorPid', 'command', 'args', 'dryRun', 'timeoutMs']);
  assert.deepStrictEqual(definition.inputSchema.required, ['action', 'projectPath', 'editorPid']);
  assert.deepStrictEqual(definition.inputSchema.properties.action.enum, ['list', 'run']);
 }));
 await test('runtime list binds exact identity and port, preserves native metadata, and leaves every handler ineligible', async () => fixture(async f => {
  const controller = new AbortController(), progress = [];
  const result = await f.provider.handleToolCall('commands', f.request, { signal: controller.signal, reportProgress: (...args) => progress.push(args) });
  const value = payload(result);
  assert.equal(result.isError, undefined); assert.equal(value.success, true); assert.equal(value.targetVerified, true);
  assert.equal(value.executionEligible, false); assert.equal(value.reason, 'provenance_unverified'); assert.equal(value.count, 3);
  assert.deepStrictEqual(value.commands.map(command => command.name), ['read_text_file', 'custom_read', 'proof_delay']);
  assert.deepStrictEqual(value.commands[0].schema.parameters, [parameter]);
  assert.equal(value.commands[0].description, 'Native description.'); assert.equal(value.commands[0].group, 'built-in');
  assert.equal(value.commands[0].classification, 'read_only'); assert.equal(value.commands[0].executionEligible, false);
  assert.equal(value.commands[1].classification, 'unknown'); assert.equal(value.commands[1].reason, 'unknown_command');
  assert.equal(value.commands[1].classificationEvidence, 'unreviewed runtime handler');
  assert.equal(value.commands[2].classification, 'unknown');
  assert.ok(value.commands.every(command => command.executionEligible === false));
  assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status', 'list', 'status']);
  for (const call of f.calls) {
   assert.equal(call.options.readOnly, true); assert.equal(call.options.cwd, fs.realpathSync(f.projectPath));
   assert.equal(call.options.signal, controller.signal); assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 3000);
   if (call.command !== 'probe') assert.deepStrictEqual(call.args, ['--project-path', fs.realpathSync(f.projectPath)]);
  }
  assert.deepStrictEqual(progress, []);
  const records = events(f.auditPath); assert.equal(records.length, 2); assert.equal(records[1].outcome, 'success');
  assert.equal(records[1].editorVersion, version); assert.equal(records[1].editorPid, pid);
 }));
 await test('read-only router audits and refuses every risk class through canonical and bare Pipeline names', async () => fixture(async f => {
  const router = new ToolRouter(true); router.register(f.provider, 'pipeline');
  const cases = [
   ['read_text_file', 'read_only', 'provenance_unverified'], ['editor_status', 'read_only', 'provenance_unverified'],
   ['add_component', 'mutating', 'policy_refused'], ['delete_asset', 'destructive', 'policy_refused'],
   ['package_resolve', 'escape', 'policy_refused'],
   ['set_authoring_root', 'escape', 'policy_refused'],
   ['set_runtime_pipeline_settings', 'escape', 'policy_refused'],
   ['add_scene_to_build', 'destructive', 'policy_refused'],
   ['remove_scene_from_build', 'destructive', 'policy_refused'],
   ['set_build_settings', 'destructive', 'policy_refused'],
   ['switch_build_target', 'destructive', 'policy_refused'],
   ['set_audio_settings', 'destructive', 'policy_refused'],
   ['set_graphics_settings', 'destructive', 'policy_refused'],
   ['set_input_settings', 'destructive', 'policy_refused'],
   ['set_physics_settings', 'destructive', 'policy_refused'],
   ['set_player_settings', 'destructive', 'policy_refused'],
   ['set_quality_settings', 'destructive', 'policy_refused'],
   ['set_time_settings', 'destructive', 'policy_refused'],
   ['set_lighting_settings', 'destructive', 'policy_refused'],
   ['set_navmesh_settings', 'destructive', 'policy_refused'],
   ['eval', 'escape', 'policy_refused'], ['eval_file', 'escape', 'policy_refused'], ['run_tests', 'escape', 'policy_refused'],
   ['write_text_file', 'escape', 'policy_refused'], ['search', 'escape', 'policy_refused'],
   ['custom_read', 'unknown', 'unknown_command'], ['proof_delay', 'unknown', 'unknown_command'], ['toString', 'unknown', 'unknown_command']
  ];
  for (const [command, classification, code] of cases) for (const dryRun of [false, true]) for (const name of ['pipeline.commands', 'commands']) {
   const result = await router.routeToolCall(name, { ...f.request, action: 'run', command, args: { path: 'private.cs', token: 'provider-private-secret' }, dryRun });
   assert.equal(result._meta.origin, 'pipeline'); assert.equal(result._meta.canonicalName, 'pipeline.commands');
   const value = payload(result); assert.equal(result.isError, true); assert.equal(value.error.code, code);
   assert.equal(value.classification, classification); assert.equal(value.executionEligible, false); assert.equal(value.executed, false);
   const terminal = events(f.auditPath).at(-1); assert.equal(terminal.outcome, 'refused'); assert.equal(terminal.classification, classification);
   assert.equal(terminal.action, dryRun ? 'plan' : 'run');
  }
  assert.equal(f.calls.length, 0); assert.ok(!fs.readFileSync(f.auditPath, 'utf8').includes('provider-private-secret'));
 }));
 await test('local dryRun discovery plans without asserting a live target or spawning CLI', async () => fixture(async f => {
  const value = payload(await f.provider.handleToolCall('commands', { ...f.request, dryRun: true }));
  assert.equal(value.success, true); assert.equal(value.executed, false); assert.equal(value.targetVerified, false);
  assert.equal(value.executionEligible, false); assert.equal(f.calls.length, 0); assert.ok(Array.isArray(value.plan));
  assert.equal(events(f.auditPath).at(-1).action, 'plan');
 }));
 await test('invalid arguments and absent audit configuration fail before backend traffic', async () => fixture(async f => {
  const invalid = [{ projectPath: 'relative' }, { editorPid: 0 }, { editorPid: '731' }, { timeoutMs: 0 }, { timeoutMs: 120001 },
   { action: ['list'] }, { action: ['run'] }, { dryRun: 'true' }, { args: [] }, { trustProject: true }, { action: 'run' }, { command: 'read_text_file' }];
  for (const change of invalid) assert.equal(payload(await f.provider.handleToolCall('commands', { ...f.request, ...change })).error.code, 'invalid_arguments');
  assert.equal(payload(await f.provider.handleToolCall('foreign.commands', f.request)).error.code, 'unknown_tool');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(payload(await f.provider.handleToolCall('commands', { ...f.request, action: 'run', command: 'eval', args: cyclic })).error.code, 'invalid_arguments');
  assert.equal(payload(await new PipelineMcpTools(f.adapter, new PipelineAudit(undefined, PIPELINE_COMMAND_NAMES)).handleToolCall('commands', f.request)).error.code, 'audit_unconfigured');
  assert.equal(f.calls.length, 0);
 }));
 await test('missing or mismatched local manifest, lock, resolved package and Editor metadata refuse discovery', async () => {
  const cases = [
   f => fs.unlinkSync(path.join(f.projectPath, 'ProjectSettings', 'ProjectVersion.txt')),
   f => json(path.join(f.projectPath, 'Packages', 'manifest.json'), { dependencies: { [packageId]: 'latest' } }),
   f => json(path.join(f.projectPath, 'Packages', 'packages-lock.json'), { dependencies: { [packageId]: { version: policy.pipelineVersion, depth: 0, source: 'local' } } }),
   f => json(path.join(f.packagePath, 'package.json'), { name: packageId, version: '0.7.0' }),
   f => { const duplicate = path.join(f.projectPath, 'Library', 'PackageCache', packageId + '@duplicate'); fs.mkdirSync(duplicate); json(path.join(duplicate, 'package.json'), { name: packageId, version: policy.pipelineVersion }); },
   f => fs.mkdirSync(path.join(f.projectPath, 'Packages', packageId)),
   f => fs.writeFileSync(path.join(f.projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2019.4.40f1\n')
  ];
  for (const change of cases) await fixture(async f => {
   change(f); const code = payload(await f.provider.handleToolCall('commands', f.request)).error.code;
   assert.ok(['project_metadata_invalid', 'pipeline_pin_mismatch'].includes(code)); assert.equal(f.calls.length, 0);
  });
 });
 await test('substring siblings, missing PID, duplicate instances and mismatched live target refuse before list', async () => {
  const cases = [
   (s, f) => { s.instances[0].project = path.join(f.root, 'project-sibling'); },
   s => { delete s.instances[0].pid; }, s => { s.instances[0].pid++; }, s => { s.instances[0].version = '6000.3.8f1'; },
   s => { s.instances[0].state = 'playing'; }, s => { s.instances[0].port = 0; },
   s => { s.instances.push({ ...s.instances[0] }); s.count = 2; }, s => { s.count = 0; s.instances = []; },
   s => { s.count = 2; }, s => { s.instances[0].pid = String(pid); }
  ];
  for (const change of cases) await fixture(async f => {
   f.adapter.invoke = async (command, args, options) => { f.calls.push({ command, args, options }); const status = f.status(); change(status, f); return ok(status); };
   assert.equal(payload(await f.provider.handleToolCall('commands', f.request)).error.code, 'target_unverified');
   assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status']);
  });
 });
 await test('wrong catalog port, duplicate names and malformed schemas cannot produce successful discovery', async () => {
  const cases = [
   c => { c.target.port++; }, c => { c.target.host = '192.0.2.1'; }, c => { c.count++; },
   c => { c.tools[1].name = c.tools[0].name; }, c => { c.tools[0].parameters.push({ ...parameter }); },
   c => { c.tools[0].parameters[0].required = 'true'; }, c => { delete c.tools[0].parameters[0].default; },
   c => { c.tools[0].description = 'x'.repeat(8193); }
  ];
  for (const change of cases) await fixture(async f => {
   f.adapter.invoke = async (command, args, options) => { f.calls.push({ command, args, options }); const catalog = f.listing(); change(catalog); return ok(command === 'status' ? f.status() : catalog); };
   assert.equal(payload(await f.provider.handleToolCall('commands', f.request)).error.code, 'invalid_catalog');
   assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status', 'list']);
  });
 });
 await test('Editor replacement or local metadata changes during list cannot retain target verification', async () => {
  for (const change of ['pid', 'metadata']) await fixture(async f => {
   let statusCalls = 0;
   f.adapter.invoke = async (command, args, options) => {
    f.calls.push({ command, args, options });
    if (command === 'list') {
     if (change === 'metadata') fs.writeFileSync(path.join(f.projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.8f1\n');
     return ok(f.listing());
    }
    const status = f.status(); if (++statusCalls === 2 && change === 'pid') status.instances[0].pid++;
    return ok(status);
   };
   assert.equal(payload(await f.provider.handleToolCall('commands', f.request)).error.code, 'target_unverified');
   assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status', 'list', 'status']);
  });
 });
 await test('probe mismatch, cancellation and native failure remain typed without fallback or raw output', async () => {
  await fixture(async f => {
   f.adapter.probe = async () => { f.calls.push({ command: 'probe' }); return ok({ version: '1.0.0-beta.13' }); };
   assert.equal(payload(await f.provider.handleToolCall('commands', f.request)).error.code, 'version_mismatch');
   assert.equal(f.calls.length, 1);
  });
  await fixture(async f => {
   const controller = new AbortController(); controller.abort();
   assert.equal(payload(await f.provider.handleToolCall('commands', f.request, { signal: controller.signal })).error.code, 'cancelled');
   assert.equal(f.calls.length, 0);
  });
  for (const [nativeCode, expected] of [['TEST_TIMED_OUT', 'TEST_TIMED_OUT'], ['API_TOKEN_SECRET', 'unknown'], ['credential-secret-host-path', 'unknown'], [undefined, undefined]]) await fixture(async f => {
   f.adapter.invoke = async command => { f.calls.push({ command }); return { ok: false, error: { code: 'timed_out', message: 'provider-private-secret', recovery: 'raw recovery', nativeCode }, exitCode: 1, signal: null, stdout: 'provider-private-secret', stderr: 'provider-private-secret' }; };
   const result = await f.provider.handleToolCall('commands', f.request);
   assert.equal(payload(result).error.code, 'timed_out'); assert.equal(payload(result).error.nativeCode, expected);
   assert.equal(payload(result).error.exitCode, 1); assert.ok(!result.content[0].text.includes('provider-private-secret'));
   assert.ok(!result.content[0].text.includes('API_TOKEN_SECRET')); assert.ok(!result.content[0].text.includes('credential-secret-host-path'));
   assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status']);
   const terminal = events(f.auditPath).at(-1); assert.equal(terminal.outcome, 'failure'); assert.equal(terminal.nativeCode, expected); assert.equal(terminal.exitCode, 1);
  });
 });
 await test('abort and total deadline stop before every next diagnostic and before successful completion', async () => {
  for (const step of ['probe', 'status-before', 'list', 'status-after']) for (const stop of ['abort', 'deadline']) await fixture(async f => {
   const controller = new AbortController(), probe = f.adapter.probe, invoke = f.adapter.invoke;
   const realNow = Date.now;
   let now = realNow();
   Date.now = () => now;
   try {
   let statusCalls = 0;
   const interrupt = async current => {
    if (current !== step) return;
    if (stop === 'abort') controller.abort();
    else now += 25;
   };
   f.adapter.probe = async options => { const result = await probe(options); await interrupt('probe'); return result; };
   f.adapter.invoke = async (command, args, options) => {
    const result = await invoke(command, args, options);
    await interrupt(command === 'status' ? (++statusCalls === 1 ? 'status-before' : 'status-after') : command);
    return result;
   };
   const result = await f.provider.handleToolCall('commands', { ...f.request, timeoutMs: stop === 'deadline' ? 20 : 3000 }, { signal: controller.signal });
   assert.equal(payload(result).error.code, stop === 'abort' ? 'cancelled' : 'timed_out');
   const count = ['probe', 'status-before', 'list', 'status-after'].indexOf(step) + 1;
   assert.deepStrictEqual(f.calls.map(call => call.command), ['probe', 'status', 'list', 'status'].slice(0, count));
   assert.equal(events(f.auditPath).at(-1).outcome, 'refused');
   } finally { Date.now = realNow; }
  });
 });
 console.log('\n  ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
 process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
