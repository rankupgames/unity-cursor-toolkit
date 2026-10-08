'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1] || ''; };
const editor = option('--editor'), version = option('--editor-version'), revision = option('--editor-revision');
if (!editor || version !== '7000.0.0a7' || revision !== '581996e1a8f7' || !fs.existsSync(editor)) throw Error('Supply the reviewed exact Editor, version and revision.');
const metadata = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:UCT_PROOF_EDITOR).VersionInfo.ProductVersion'], { timeout: 10000, windowsHide: true, encoding: 'utf8', env: { ...process.env, UCT_PROOF_EDITOR: editor } });
if (metadata.status !== 0 || metadata.stdout.trim() !== version + '_' + revision) throw Error('Exact executable metadata mismatch.');
const source = path.join(repo, 'Packages/com.rankupgames.unity-cursor-toolkit');
const runnerRelative = 'Runtime/AgentCommands/AgentCommandRunner.cs';
const fixedRunner = fs.readFileSync(path.join(source, runnerRelative), 'utf8');
if (!fixedRunner.includes('public AgentCommandHandler Handler { get; private set; }') || !fixedRunner.includes('Handler = null;')) throw Error('Expected canonical fix is absent.');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => fs.existsSync(file);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const roots = [];
function ownedProcesses(root) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^Unity" -and $_.CommandLine -and $_.CommandLine.Contains($env:UCT_PROOF_ROOT) } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress'], { timeout: 10000, windowsHide: true, encoding: 'utf8', env: { ...process.env, UCT_PROOF_ROOT: root } });
  if (result.status !== 0) throw Error('Owned process query failed.');
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
function createFixture(variant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-consumer-' + variant + '-'));
  roots.push(root);
  for (const relative of ['Assets/Consumer', 'Assets/Coordinator', 'Packages', 'ProjectSettings', 'proof']) fs.mkdirSync(path.join(root, relative), { recursive: true });
  fs.cpSync(source, path.join(root, 'Packages/com.rankupgames.unity-cursor-toolkit'), { recursive: true });
  if (variant === 'baseline') fs.writeFileSync(path.join(root, 'Packages/com.rankupgames.unity-cursor-toolkit', runnerRelative), fixedRunner.replace('public AgentCommandHandler Handler { get; private set; }', 'public AgentCommandHandler Handler { get; }').replace(/\r?\n[ \t]*Handler = null;/, ''));
  const dependencies = { 'com.rankupgames.unity-cursor-toolkit': 'file:com.rankupgames.unity-cursor-toolkit' };
  const builtins = path.join(path.dirname(editor), 'Data/Resources/PackageManager/BuiltInPackages');
  for (const name of fs.readdirSync(builtins).filter(name => name.startsWith('com.unity.modules.') && fs.existsSync(path.join(builtins, name, 'package.json')))) dependencies[name] = JSON.parse(fs.readFileSync(path.join(builtins, name, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
  fs.writeFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\nm_EditorVersionWithRevision: ' + version + ' (' + revision + ')\n');
  for (const name of ['Consumer', 'Coordinator']) {
    fs.copyFileSync(path.join(__dirname, name + '.cs'), path.join(root, 'Assets', name, name + '.cs'));
    fs.writeFileSync(path.join(root, 'Assets', name, name + '.asmdef'), JSON.stringify({ name: 'UCT.Proof.' + name, references: ['UnityCursorToolkit.Runtime', 'UnityCursorToolkit.Editor'], includePlatforms: ['Editor'], autoReferenced: false }, null, 2));
  }
  return root;
}
async function run(variant) {
  const root = createFixture(variant), proof = path.join(root, 'proof');
  const args = ['-batchmode', '-nographics', '-projectPath', root, '-logFile', path.join(proof, 'editor.log'), '-executeMethod', 'UCT.ConsumerProof.Coordinator.Run'];
  const child = spawn(editor, args, { env: { ...process.env, UCT_CONSUMER_PROOF: proof, UCT_CONSUMER_VARIANT: variant }, stdio: 'ignore', windowsHide: true });
  if (child.pid) fs.writeFileSync(path.join(proof, 'owner.pid'), String(child.pid));
  let exited = false, exitCode = null, spawnError = '';
  child.once('error', error => { spawnError = error.code || 'spawn_error'; exited = true; });
  child.once('exit', code => { exited = true; exitCode = code; });
  console.log(JSON.stringify({ phase: 'launched', variant, pid: child.pid }));
  const started = Date.now(); let readyAt = 0, nextProgress = started + 30000, seen = new Set();
  let runnerFailure = "";
  try {
  while (!exited && Date.now() - started < 360000) {
    if (!readyAt && exists(path.join(proof, 'ready.json'))) {
      const ready = json(path.join(proof, 'ready.json'));
      if (ready.pid !== child.pid || ready.editorVersion !== version || ready.variant !== variant) throw Error('Fixture identity mismatch.');
      readyAt = Date.now(); console.log(JSON.stringify({ phase: 'ready', variant, pid: child.pid }));
    }
    const request = path.join(proof, 'reload.request');
    if (exists(request)) {
      const digit = fs.readFileSync(request, 'utf8').trim();
      if (!['2', '3'].includes(digit) || seen.has(digit)) throw Error('Unexpected reload request.');
      seen.add(digit);
      const consumer = fs.readFileSync(path.join(__dirname, 'Consumer.cs'), 'utf8').replace('private const string Version = "v1";', 'private const string Version = "v' + digit + '";');
      fs.writeFileSync(path.join(root, 'Assets/Consumer/Consumer.cs'), consumer);
      fs.unlinkSync(request); fs.writeFileSync(path.join(proof, 'refresh.request'), digit);
      console.log(JSON.stringify({ phase: 'source_changed', variant, version: 'v' + digit }));
    }
    if (Date.now() >= nextProgress) { console.log(JSON.stringify({ phase: 'waiting', variant, ready: !!readyAt, elapsedSeconds: Math.round((Date.now() - started) / 1000) })); nextProgress += 30000; }
    if ((!readyAt && Date.now() - started > 180000) || (readyAt && Date.now() - readyAt > 160000)) { fs.writeFileSync(path.join(proof, 'quit.request'), 'bounded owned shutdown'); break; }
    await sleep(250);
  }
  } catch (error) { runnerFailure = error.code || "proof_runner_error"; fs.writeFileSync(path.join(proof, "quit.request"), "bounded owned shutdown"); }
  for (let i = 0; !exited && i < 120; i++) await sleep(250);
  let forcedCleanup = false;
  if (!exited && ownedProcesses(root).includes(child.pid)) {
    forcedCleanup = true;
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    for (let i = 0; !exited && i < 40; i++) await sleep(250);
  }
  const processes = ownedProcesses(root), observation = exists(path.join(proof, 'observation.json')) ? json(path.join(proof, 'observation.json')) : null;
  const events = exists(path.join(proof, 'events.ndjson')) ? fs.readFileSync(path.join(proof, 'events.ndjson'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  const normalExitConfirmed = exited && exitCode === 0 && exists(path.join(proof, 'quitting')) && !forcedCleanup && processes.length === 0;
  const mainEvents = events.filter(event => event.pid === child.pid || event.phase === 'patch_request');
  const foreignEventCount = events.filter(event => event.pid && event.pid !== child.pid).length;
  const result = { runnerFailure, foreignEventCount, variant, exitCode, spawnError, forcedCleanup, normalExitConfirmed, remainingOwnedPids: processes, observation, events: mainEvents };
  if (!normalExitConfirmed || !observation || observation.failure || runnerFailure) { console.log(JSON.stringify({ phase: 'failed', variant, exitCode, normalExitConfirmed, failure: observation && observation.failure, fixture: root })); return result; }
  if (variant === 'baseline') result.expectedOldFailure = observation.cases.length === 3 && observation.cases.every(item => !item.collected) && !observation.terminalHandlersCollected;
  else {
    const reloads = observation.reloads || [];
    result.ownerHooksPassed = ['v1', 'v2', 'v3'].every(v => mainEvents.filter(e => e.phase === 'patch' && e.version === v).length === 1)
      && ['v1', 'v2'].every(v => mainEvents.some(e => e.phase === 'unloading' && e.version === v && e.removed))
      && reloads.length === 2 && reloads.every(r => r.before.consumerMvid !== r.after.consumerMvid);
    result.selectiveRetentionObserved = reloads.length === 2 && reloads.every(r => r.retained);
  }
  console.log(JSON.stringify({ phase: 'finished', variant, normalExitConfirmed, expectedOldFailure: result.expectedOldFailure, terminalHandlersCollected: observation.terminalHandlersCollected, ownerHooksPassed: result.ownerHooksPassed, selectiveRetentionObserved: result.selectiveRetentionObserved }));
  return result;
}
(async () => {
  const baseline = await run('baseline');
  const fixed = baseline.normalExitConfirmed ? await run('fixed') : null;
  const passed = !!(baseline.expectedOldFailure && fixed && fixed.normalExitConfirmed && fixed.observation.passed && fixed.ownerHooksPassed);
  const evidence = { checkedAt: new Date().toISOString(), editorVersion: version, editorRevision: revision, platform: process.platform, passed, source: { runner: hash(fixedRunner), consumer: hash(fs.readFileSync(path.join(__dirname, 'Consumer.cs'))), coordinator: hash(fs.readFileSync(path.join(__dirname, 'Coordinator.cs'))) }, baseline, fixed };
  const directory = path.join(__dirname, 'evidence', evidence.checkedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'observation.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ phase: 'complete', passed, evidence: path.relative(repo, path.join(directory, 'observation.json')) }));
  // Retain only failed owned fixtures for diagnosis. Remove successful fixtures after exact scoped absence.
  if (passed) for (const root of roots) {
    const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('uct-consumer-') || ownedProcesses(root).length) throw Error('Fixture cleanup boundary failed.');
    fs.rmSync(resolved, { recursive: true });
  }
  process.exitCode = passed ? 0 : 1;
})().catch(error => { console.error(error.message.replaceAll(os.homedir(), '<HOME>')); process.exitCode = 1; });
