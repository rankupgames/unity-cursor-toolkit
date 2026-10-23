'use strict';
const assert = require('assert');
const path = require('path');
const { createStandaloneMcpRuntime } = require('../out/mcp/server');
let passed = 0, failed = 0;
const projectPath = path.resolve(__dirname, '../..');
const capabilities = { success: true, backend: 'bridge', available: true, projectPath, editorPid: 731, editorVersion: '6000.3.9f1', modes: ['EditMode', 'PlayMode'], supportsCancellation: true };
const snapshot = (args, status = 'listed') => ({ success: !['cancelled', 'error'].includes(status), backend: 'bridge', editorVersion: capabilities.editorVersion, editorPid: 731, runId: args.runId, mode: args.mode, status,
 workStopped: ['listed', 'completed', 'failed', 'cancelled', 'timed_out', 'error'].includes(status), selection: [], tests: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, notRun: 0, durationMs: 0 },
 ...(status === 'cancelled' ? { error: { code: 'cancelled', message: 'Cancelled', recovery: 'Inspect the run.' } } : {}) });
async function test(name, run) { try { await run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
async function main() {
 const { ToolRouter } = require('../out/mcp/toolRouter');
 const provider = (names, calls, result = { content: [{ type: 'text', text: 'unchanged' }], _meta: { custom: 'kept' } }) => ({
  toolGroupName: 'fixture', getTools: () => names.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, _meta: { custom: 'kept' } })),
  handleToolCall: async (name, args, context) => { calls.push({ name, args, context }); return result; }
 });
 await test('router advertises canonical names and preserves schemas/content through both spellings', async () => {
  const router = new ToolRouter(), calls = [], p = provider(['read_console'], calls); router.register(p);
  const definition = router.getToolDefinitions()[0], original = p.getTools()[0];
  assert.equal(definition.name, 'toolkit.read_console'); assert.deepStrictEqual(definition.inputSchema, original.inputSchema);
  assert.deepStrictEqual(definition._meta, { custom: 'kept', origin: 'toolkit', canonicalName: 'toolkit.read_console', aliases: ['read_console'] });
  const args = { value: 'same' }, context = { signal: new AbortController().signal };
  for (const name of ['read_console', 'toolkit.read_console']) {
   const result = await router.routeToolCall(name, args, context);
   assert.deepStrictEqual(result.content, [{ type: 'text', text: 'unchanged' }]);
   assert.deepStrictEqual(result._meta, { custom: 'kept', origin: 'toolkit', canonicalName: 'toolkit.read_console' });
  }
  assert.ok(calls.every(call => call.name === 'read_console' && call.args === args && call.context === context));
 });
 await test('registration refuses invalid origins, qualified local names and overlong canonical names', async () => {
  const router = new ToolRouter(), calls = [];
  for (const origin of ['', 'toolkit.foreign', 'Toolkit', 'x'.repeat(127), null]) {
   assert.throws(() => router.register(provider(['read_console'], calls), origin), /Invalid tool origin/);
  }
  for (const name of ['', 'foreign.read_console', 'x'.repeat(121), undefined]) {
   assert.throws(() => router.register(provider([name], calls)), /Invalid canonical tool name/);
  }
  assert.deepStrictEqual(router.getToolDefinitions(), []); assert.equal(calls.length, 0);
 });
 await test('read-only canonical batch policy inspects every nested alias before dispatch', async () => {
  const runtime = createStandaloneMcpRuntime(true); let calls = 0;
  runtime.connection.request = async () => { calls++; throw Error('Unexpected transport'); };
  try { for (const tool of ['manage_gameobject', 'toolkit.manage_gameobject', 'assistant.read_console']) {
   const result = await runtime.handleRequest({id:tool,method:'tools/call',params:{name:'toolkit.batch_execute',arguments:{operations:[{tool,args:{action:'create'}}]}}});
   assert.equal(result.isError,true); assert.equal(JSON.parse(result.content[0].text).error.code,'policy_refused');
  } assert.equal(calls,0); } finally { await runtime.dispose(); }
 });
 await test('duplicate canonical registration fails atomically before dispatch', async () => {
  const router = new ToolRouter(), calls = []; router.register(provider(['first'], calls));
  assert.throws(() => router.register(provider(['second','first'], calls)), /Duplicate canonical tool.*toolkit.first/);
  assert.deepStrictEqual(router.getToolDefinitions().map(tool => tool.name), ['toolkit.first']);
  assert.equal(calls.length, 0);
  assert.equal((await router.routeToolCall('first', {})).content[0].text, 'unchanged');
 });
 await test('toolkit alias wins independent of registration order and qualified calls retain origin', async () => {
  const router = new ToolRouter(), calls = [];
  router.register(provider(['read_console'], calls), 'assistant'); router.register(provider(['read_console'], calls));
  assert.equal((await router.routeToolCall('read_console', {}))._meta.origin, 'toolkit');
  assert.equal((await router.routeToolCall('assistant.read_console', {}))._meta.origin, 'assistant');
 });
 await test('non-toolkit alias ambiguity refuses dispatch with canonical candidates', async () => {
  const router = new ToolRouter(), calls = [];
  router.register(provider(['command'], calls), 'pipeline'); router.register(provider(['command'], calls), 'assistant');
  const result = await router.routeToolCall('command', {}), payload = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true); assert.equal(payload.error.code, 'ambiguous_tool');
  assert.deepStrictEqual(payload.error.candidates, ['assistant.command','pipeline.command']); assert.equal(calls.length, 0);
 });
 await test('unknown namespace does not fall back to a bare alias', async () => {
  const router = new ToolRouter(), calls = []; router.register(provider(['read_console'], calls));
  const result = await router.routeToolCall('foreign.read_console', {}), payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.code, 'unknown_tool'); assert.deepStrictEqual(payload.error.candidates, ['toolkit.read_console']); assert.equal(calls.length, 0);
 });
 await test('catalog resource includes canonical name, origin and legacy aliases', async () => {
  const runtime = createStandaloneMcpRuntime(true);
  try {
   const response = await runtime.handleRequest({ method: 'resources/read', params: { uri: 'unity://tools/catalog' } });
   const catalog = JSON.parse(response.contents[0].text), entry = catalog.find(tool => tool.name === 'toolkit.read_console');
   assert.deepStrictEqual(entry._meta, { origin: 'toolkit', canonicalName: 'toolkit.read_console', aliases: ['read_console'] });
  } finally { await runtime.dispose(); }
 });
 await test('canonical and legacy mutations share read-only refusal and dry-run plan without transport', async () => {
  const runtime = createStandaloneMcpRuntime(true); let calls = 0; runtime.connection.request = async () => { calls++; throw Error('Unexpected backend traffic'); };
  try { for (const name of ['manage_gameobject','toolkit.manage_gameobject']) {
   const denied = await runtime.handleRequest({ id: name, method: 'tools/call', params: { name, arguments: { action: 'create', name: 'owned' } } });
   assert.equal(JSON.parse(denied.content[0].text).error.code, 'policy_refused'); assert.equal(denied._meta.canonicalName, 'toolkit.manage_gameobject');
   const plan = await runtime.handleRequest({ id: name+'-plan', method: 'tools/call', params: { name, arguments: { action: 'create', name: 'owned', dryRun: true } } });
   assert.equal(JSON.parse(plan.content[0].text).dryRun, true);
  } assert.equal(calls, 0); } finally { await runtime.dispose(); }
 });
 await test('unclassified origins fail closed in read-only mode even with dryRun', async () => {
  const runtime = createStandaloneMcpRuntime(true), calls = [];
  runtime.router.register(provider(['eval'], calls), 'pipeline');
  try { for (const name of ['eval','pipeline.eval']) {
   const result = await runtime.handleRequest({ id: name, method: 'tools/call', params: { name, arguments: { dryRun: true } } });
   assert.equal(JSON.parse(result.content[0].text).error.code, 'policy_refused'); assert.equal(result._meta.origin, 'pipeline');
  } assert.equal(calls.length, 0); } finally { await runtime.dispose(); }
 });
 await test('canonical batch operations normalize Unity names and refuse direct-only test aliases', async () => {
  const runtime = createStandaloneMcpRuntime(false), calls = [];
  runtime.connection.request = async (_command,payload) => { calls.push(payload); return { result: { success: true } }; };
  try {
   const result = await runtime.handleRequest({ id:'batch',method:'tools/call',params:{name:'toolkit.batch_execute',arguments:{operations:[{tool:'toolkit.manage_gameobject',args:{action:'find'}}]}}});
   assert.ok(!result.isError); assert.equal(calls[0].toolName, 'manage_gameobject');
   calls.length = 0;
   for (const tool of ['run_tests','toolkit.run_tests','assistant.run_tests']) {
    const refused = await runtime.handleRequest({ id:tool,method:'tools/call',params:{name:'toolkit.batch_execute',arguments:{operations:[{tool,args:{mode:'PlayMode'}}]}}});
    assert.equal(refused.isError,true); assert.equal(calls.length,0);
   }
  } finally { await runtime.dispose(); }
 });

 await test('nested batches refuse foreign and direct-only tools before plans or forwarding', async () => {
  for (const readOnly of [true,false]) {
   const runtime = createStandaloneMcpRuntime(readOnly); let calls = 0;
   runtime.connection.request = async () => { calls++; return { result: { success: true } }; };
   try { for (const dryRun of [true,false]) {
    for (const tool of ['assistant.read_console','test_runner','list_tests','toolkit.run_tests']) {
     const result = await runtime.handleRequest({ id:tool,method:'tools/call',params:{name:'toolkit.batch_execute',arguments:{dryRun,operations:[
      {tool:'toolkit.manage_gameobject',args:{action:'create',name:'owned'}},
      {tool:'batch_execute',args:{operations:[{tool:'toolkit.batch_execute',args:{operations:[{tool,args:{mode:'EditMode'}}]}}]}}
     ]}}});
     assert.equal(result.isError,true, 'Accepted nested '+tool+' with dryRun='+dryRun+' and readOnly='+readOnly);
     assert.equal(calls,0, 'Forwarded before refusing nested '+tool);
    }
   } } finally { await runtime.dispose(); }
  }
 });

 await test('standalone catalog registers additive tools and read-only policy blocks execution before transport', async () => {
  const runtime = createStandaloneMcpRuntime(true); let calls = 0;
  runtime.connection.request = async () => { calls++; throw Error('Unexpected transport'); };
  try {
   const tools = (await runtime.handleRequest({ method: 'tools/list' })).tools;
   const { isToolCallClassified } = require('../out/mcp/toolMetadata');
   for (const tool of tools) assert.ok(isToolCallClassified(tool.name, { operations: [] }), 'Missing policy classification: '+tool.name);
   const list = tools.find(tool => tool.name === 'toolkit.list_tests'), run = tools.find(tool => tool.name === 'toolkit.run_tests');
   assert.strictEqual(list.annotations.readOnlyHint, true); assert.strictEqual(run.annotations.readOnlyHint, false);
   assert.deepStrictEqual(run.inputSchema.properties.backend.enum, ['auto', 'cli', 'bridge']);
   const result = await runtime.handleRequest({ id: 1, method: 'tools/call', params: { name: 'run_tests', arguments: { projectPath, mode: 'EditMode' } } });
   assert.strictEqual(result.isError, true); assert.strictEqual(JSON.parse(result.content[0].text).error.code, 'policy_refused'); assert.strictEqual(calls, 0);
  } finally { runtime.dispose(); }
 });
 await test('batch calls cannot bypass test policy through the internal Editor tool', async () => {
  for (const readOnly of [true,false]) {
   const runtime=createStandaloneMcpRuntime(readOnly);let calls=0;runtime.connection.request=async()=>{calls++;return null;};
   try { for(const tool of ['test_runner','list_tests','run_tests','toolkit.test_runner','toolkit.list_tests','toolkit.run_tests','assistant.run_tests']) {
    const result=await runtime.handleRequest({id:tool,method:'tools/call',params:{name:'batch_execute',arguments:{operations:[{tool,args:{action:'run',mode:'PlayMode'}}]}}});
    assert.equal(result.isError,true);assert.equal(calls,0);
   } } finally { await runtime.dispose(); }
  }
 });
 await test('MCP dry-run discovers in read-only mode and emits standard progress with the supplied token', async () => {
  const notifications = [], runtime = createStandaloneMcpRuntime(true, item => notifications.push(item)); const actions = [];
  runtime.connection.request = async (_command, payload) => { actions.push(payload.args.action); return { result: payload.args.action === 'capabilities' ? capabilities : snapshot(payload.args, payload.args.action === 'list' ? 'discovering' : 'listed') }; };
  try {
   const result = await runtime.handleRequest({ id: 2, method: 'tools/call', params: { name: 'run_tests', _meta: { progressToken: 'progress-2' }, arguments: { projectPath, mode: 'EditMode', dryRun: true } } });
   assert.strictEqual(result.isError, false); assert.deepStrictEqual(actions, ['capabilities', 'list', 'status']);
   assert.deepStrictEqual(notifications.map(item => item.params.progress), [1, 2, 3]);
   assert.strictEqual(notifications[0].method, 'notifications/progress'); assert.strictEqual(notifications[0].params.progressToken, 'progress-2');
   assert.ok(!JSON.stringify(result).includes('ownerToken'));
  } finally { runtime.dispose(); }
 });
 await test('MCP cancellation targets only its active request and waits for the owned bridge terminal state', async () => {
  const runtime = createStandaloneMcpRuntime(false), actions = []; let began; const started = new Promise(resolve => { began = resolve; }); let owned;
  runtime.connection.request = async (_command, payload) => {
   const args = payload.args; actions.push(args.action);
   if (args.action === 'capabilities') return { result: capabilities };
   if (args.action === 'run') { owned = { ...args }; began(); return { result: snapshot(args, 'running') }; }
   assert.strictEqual(args.ownerToken, owned.ownerToken); assert.strictEqual(args.runId, owned.runId); assert.strictEqual(args.editorPid, owned.editorPid);
   return { result: snapshot(args, 'cancelled') };
  };
  try {
   const pending = runtime.handleRequest({ id: 'run-3', method: 'tools/call', params: { name: 'toolkit.run_tests', arguments: { projectPath, mode: 'PlayMode', backend: 'bridge' } } });
   await started; await runtime.handleRequest({ method: 'notifications/cancelled', params: { requestId: 'unrelated' } });
   assert.ok(!actions.includes('cancel'));
   await runtime.handleRequest({ method: 'notifications/cancelled', params: { requestId: 'run-3' } });
   const result = JSON.parse((await pending).content[0].text);
   assert.strictEqual(result.status, 'cancelled'); assert.ok(actions.includes('cancel'));
   assert.ok(!JSON.stringify(result).includes(owned.ownerToken));
  } finally { runtime.dispose(); }
 });
 await test('runtime disposal keeps the bridge open until owned cancellation settles', async () => {
  const runtime = createStandaloneMcpRuntime(false); let began, stopped = false, disconnected = false;
  const started = new Promise(resolve => { began = resolve; });
  runtime.connection.dispose = () => { assert.strictEqual(stopped, true); disconnected = true; };
  runtime.connection.request = async (_command, payload) => {
   const args = payload.args;
   if (args.action === 'capabilities') return { result: capabilities };
   if (args.action === 'run') { began(); return { result: snapshot(args, 'running') }; }
   assert.strictEqual(disconnected, false); await new Promise(resolve => setTimeout(resolve, 10)); stopped = true;
   return { result: snapshot(args, 'cancelled') };
  };
  const pending = runtime.handleRequest({ id: 'dispose-run', method: 'tools/call', params: { name: 'run_tests', arguments: { projectPath, mode: 'EditMode', backend: 'bridge' } } });
  await started; await runtime.dispose(); const result = JSON.parse((await pending).content[0].text);
  assert.strictEqual(result.status, 'cancelled'); assert.strictEqual(disconnected, true);
 });
 await test('real standalone stdio entrypoint forwards progress and cancellation without VS Code', async () => {
  const net = require('net'), cp = require('child_process'), os = require('os');
  const sockets = new Set(); let input = '', cancellationSeen = false;
  const server = net.createServer(socket => {
   sockets.add(socket); socket.on('close', () => sockets.delete(socket));
   socket.on('data', bytes => {
    input += bytes.toString(); const lines = input.split('\n'); input = lines.pop();
    for (const line of lines) {
     const request = JSON.parse(line), args = request.args;
     const result = args.action === 'capabilities' ? capabilities : snapshot(args, args.action === 'cancel' ? 'cancelled' : 'running');
     if (args.action === 'cancel') cancellationSeen = true;
     socket.write(JSON.stringify({ command: 'mcpToolResult', _requestId: request._requestId, result }) + '\n');
    }
   });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../out/mcp/server.js')], { cwd: os.tmpdir(), env: { ...process.env, UNITY_CURSOR_TOOLKIT_MCP_PORTS: String(server.address().port), UNITY_CURSOR_TOOLKIT_MCP_READ_ONLY: '0' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let progressSeen = false, output = ''; child.stderr.resume();
  try {
   const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Standalone protocol deadline')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', bytes => {
     output += bytes.toString(); const lines = output.split('\n'); output = lines.pop();
     for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { clearTimeout(timer); reject(Error('Non-JSON stdout')); continue; }
      if (message.method === 'notifications/progress') {
       progressSeen = message.params.progressToken === 'wire-progress';
       child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'wire-run' } }) + '\n');
      } else if (message.id === 'wire-run') { clearTimeout(timer); resolve(message); }
     }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'wire-run', method: 'tools/call', params: { name: 'toolkit.run_tests', _meta: { progressToken: 'wire-progress' }, arguments: { projectPath, mode: 'EditMode', backend: 'bridge', timeoutMs: 4000 } } }) + '\n');
   });
   assert.strictEqual(JSON.parse(reply.result.content[0].text).status, 'cancelled');
   assert.deepStrictEqual(reply.result._meta, { origin: 'toolkit', canonicalName: 'toolkit.run_tests' });
   assert.strictEqual(progressSeen, true); assert.strictEqual(cancellationSeen, true);
  } finally {
   child.stdin.end();
   await new Promise(resolve => { if (child.exitCode !== null) { resolve(); return; } const deadline = setTimeout(() => child.kill(), 2000); child.once('exit', () => { clearTimeout(deadline); resolve(); }); });
   for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  }
 });
 console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`); if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
