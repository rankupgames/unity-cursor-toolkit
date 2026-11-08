// Exercise the shipping adapter against the existing deterministic CLI test sources.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { UnityCliAdapter } = require('../../unity-cursor-toolkit/out/core/unityCliAdapter');
const { UnityCliTestAdapter } = require('../../unity-cursor-toolkit/out/core/unityCliTestAdapter');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const metadata = arg('--metadata-project'), cli = arg('--cli');
if (!metadata || !cli) throw Error('Pass --metadata-project from the owned baseline fixture and --cli.');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-cli-adapter-proof-'));
const output = path.join(__dirname, 'captures', 'test-adapter-' + new Date().toISOString().replace(/[:.]/g, '-'));
const record = { observedAt: new Date().toISOString(), passed: false, cases: [], editorsRemaining: null, fixtureRemoved: false,
 sources: ['unityCliTestAdapter.ts', 'unityTestTypes.ts', 'unityTestPrivacy.ts'].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../unity-cursor-toolkit/src/core', file))).digest('hex') })) };
function processes() {
 const script = "$root=$env:UCT_OWNED_TEST_PROJECT;ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Unity.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | Select-Object -ExpandProperty ProcessId)";
 const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UCT_OWNED_TEST_PROJECT: fixture } });
 if (result.status !== 0) throw Error('Owned process query failed'); return JSON.parse(result.stdout);
}
(async () => {
 try {
  fs.cpSync(path.join(__dirname, 'fixture', 'Assets'), path.join(fixture, 'Assets'), { recursive: true, filter: file => !file.endsWith('.meta') && !file.endsWith('Proof.unity') });
  for (const directory of ['Packages', 'ProjectSettings']) fs.mkdirSync(path.join(fixture, directory));
  for (const file of ['Packages/manifest.json', 'Packages/packages-lock.json', 'ProjectSettings/ProjectVersion.txt']) fs.copyFileSync(path.join(metadata, file), path.join(fixture, file));
  record.editorVersion = /m_EditorVersion: (.+)/.exec(fs.readFileSync(path.join(fixture, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))[1].trim();
  const lock = JSON.parse(fs.readFileSync(path.join(fixture, 'Packages/packages-lock.json')));
  record.packages = Object.entries(lock.dependencies).filter(([name]) => ['com.unity.test-framework', 'com.unity.ext.nunit'].includes(name)).map(([name, data]) => ({ name, source: data.source }));
  const adapter = new UnityCliTestAdapter(new UnityCliAdapter(cli));
  for (const [mode, test, expected] of [['EditMode', 'CliEditTests.Passing', 'completed'], ['EditMode', 'CliEditTests.DeliberateFailure', 'failed'], ['PlayMode', 'CliPlayTests.Passing', 'completed']]) {
   const start = Date.now();
   const result = await adapter.runTests({ projectPath: fixture, mode, filters: { test }, timeoutMs: 180000 });
   const remaining = processes(); record.cases.push({ mode, test, elapsedMs: Date.now() - start, result, editorsRemaining: remaining });
   console.log(JSON.stringify({ mode, test, status: result.status, error: result.error?.code, total: result.summary.total, editorsRemaining: remaining }));
   assert.equal(result.editorVersion, record.editorVersion); assert.equal(result.status, expected); assert.equal(result.summary.total, 1); assert.deepEqual(result.selection, [test]); assert.equal(remaining.length, 0);
  }
  record.passed = true;
 } catch (error) { record.failure = error.message.replace(/[A-Za-z]:[\\/][^\r\n]*/g, '<private-path>'); process.exitCode = 1; }
 finally {
  record.editorsRemaining = processes();
  if (record.editorsRemaining.length === 0) {
   const resolved = path.resolve(fixture);
   if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('uct-cli-adapter-proof-')) throw Error('Unsafe fixture cleanup path');
   fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); record.fixtureRemoved = true;
  }
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ output, passed: record.passed, editorsRemaining: record.editorsRemaining, fixtureRemoved: record.fixtureRemoved }));
 }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
