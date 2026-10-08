'use strict';
const assert = require('assert'), Module = require('module');
const originalLoad = Module._load, commands = new Map(), output = [];
let choices = [], cancel, disposed = false;
const vscode = { ProgressLocation: { Notification: 15 }, window: {
 createOutputChannel: () => ({ show() {}, appendLine: text => output.push(text), dispose: () => { disposed = true; } }),
 showQuickPick: async () => choices.shift(), showInputBox: async () => choices.shift(),
 withProgress: async (_options, run) => run({ report() {} }, { onCancellationRequested: callback => { cancel = callback; return { dispose() {} }; } })
} };
Module._load = (name, ...rest) => name === 'vscode' ? vscode : originalLoad.call(Module, name, ...rest);
const { UnityTestCommands } = require('../out/mcp/unityTestCommands');
Module._load = originalLoad;
let passed = 0, failed = 0;
async function test(name, run) { try { await run(); passed++; console.log('PASS ' + name); } catch(error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
const result = { backend: 'bridge', editorVersion: '6000.3.9f1', mode: 'EditMode', status: 'failed', runId: 'owned-run', tests: [{ status: 'failed', fullName: 'Game.Tests.Fails', durationMs: 4, message: 'Expected true', stackTrace: '<project>/Tests.cs:10' }], summary: { total: 1, passed: 0, failed: 1 }, error: { code: 'tests_failed', message: 'One test failed.', recovery: 'Inspect the failure.' } };
async function main() {
 await test('command palette selections use the shared provider and print backend, exact version and failure details', async () => {
  let request; const ui = new UnityTestCommands({ registerCommand: (name, run) => commands.set(name, run) }, { execute: async (name,args) => { request={name,args}; return result; } });
  try {
   choices = ['EditMode','bridge','namespace','Game.Tests']; await commands.get('unity-cursor-toolkit.tests.run')();
   assert.deepStrictEqual(request,{name:'run_tests',args:{mode:'EditMode',backend:'bridge',filter:{namespace:'Game.Tests'}}});
   assert(output.some(line=>line.includes('bridge | Unity 6000.3.9f1'))); assert(output.includes('Expected true')); assert(output.includes('<project>/Tests.cs:10')); assert(output.some(line=>line.startsWith('tests_failed:')));
   choices = [undefined]; request = undefined; await commands.get('unity-cursor-toolkit.tests.list')(); assert.strictEqual(request,undefined);
  } finally { ui.dispose(); }
 });
 await test('read-only PlayMode refusal appears as the typed policy error without transport', async () => {
  const {UnityTestMcpTools}=require('../out/mcp/unityTestTools');let calls=0;
  const tools=new UnityTestMcpTools({request:async()=>{calls++;return null;},send(){}},()=>process.cwd(),undefined,true);
  const ui=new UnityTestCommands({registerCommand:(name,run)=>commands.set(name,run)},tools);
  try { await commands.get('unity-cursor-toolkit.tests.run')({mode:'PlayMode',backend:'auto',filter:{}});assert.equal(calls,0);assert(output.some(line=>line.startsWith('policy_refused:'))); }
  finally {ui.dispose();}
 });
 await test('command cancellation and module shutdown abort only owned requests and wait for completion', async () => {
  let aborted=0; const ui = new UnityTestCommands({registerCommand:(name,run)=>commands.set(name,run)}, {execute:async(_name,_args,context)=>new Promise(resolve=>context.signal.addEventListener('abort',()=>{aborted++;resolve({...result,status:'cancelled'});},{once:true}))});
  try {
   const first=commands.get('unity-cursor-toolkit.tests.run')({mode:'EditMode',backend:'bridge',filter:{}}); cancel(); await first; assert.equal(aborted,1);
   const second=commands.get('unity-cursor-toolkit.tests.list')({mode:'PlayMode',backend:'bridge',filter:{}}); await ui.stop(); await second; assert.equal(aborted,2);
  } finally { ui.dispose(); }
  assert.equal(disposed,true);
 });
 console.log(`\n${passed} passed, ${failed} failed, ${passed+failed} total`);if(failed)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1});
