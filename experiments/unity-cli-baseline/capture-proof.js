// Execute one bounded case only in the owned exact-version fixture.
(async () => {
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const repo = path.resolve(__dirname, '../..');
const cli = process.env.UNITY_CLI_BINARY || 'unity';
if (spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim() !== '1.0.0-beta.12') throw new Error('CLI version differs');
const inventoryResult = spawnSync(cli, ['editors', '-i', '--format', 'json', '--no-log-proxy', '--non-interactive'], { encoding: 'utf8', timeout: 30000 });
if (inventoryResult.status !== 0) throw new Error('Cannot resolve installed Editor roots');
const installedEditors = JSON.parse(inventoryResult.stdout).data;
const editorRoots = installedEditors.map(editor => ({ root: path.dirname(editor.location), label: '<editor:' + editor.version + '>' }));
const version = process.env.UNITY_CLI_PROOF_EDITOR || '6000.6.4f1';
if (!['6000.3.9f1', '6000.6.4f1'].includes(version)) throw new Error('Use a recorded exact Editor version');
const project = path.join(__dirname, 'fixture-' + version);
if (!fs.existsSync(project)) {
    fs.mkdirSync(project, { recursive: true });
    fs.cpSync(path.join(__dirname, 'fixture/Assets'), path.join(project, 'Assets'), { recursive: true, filter: file => !file.endsWith('.meta') && !file.endsWith('Proof.unity') });
    fs.mkdirSync(path.join(project, 'ProjectSettings'));
    fs.writeFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
    const cache = path.join(repo, 'CursorUnityTool/Library/PackageCache');
    const installed = installedEditors.find(editor => editor.version === version);
    if (!installed) throw new Error('Exact fixture Editor not installed');
    const builtIn = path.join(path.dirname(installed.location), 'Data/Resources/PackageManager/BuiltInPackages');
    const dependencies = { 'com.unity.modules.imgui': '1.0.0', 'com.unity.modules.jsonserialize': '1.0.0' };
    for (const [name, expected] of [['com.unity.test-framework', version === '6000.6.4f1' ? '1.8.0' : '1.6.0'], ['com.unity.ext.nunit', version === '6000.6.4f1' ? '2.1.0' : '2.0.5']]) {
        if (version === '6000.6.4f1') {
            const shipped = path.join(builtIn, name);
            if (JSON.parse(fs.readFileSync(path.join(shipped, 'package.json'), 'utf8')).version !== expected) throw new Error('Shipped package version differs: ' + name);
            dependencies[name] = 'file:' + shipped.replaceAll('\\', '/');
            continue;
        }
        const directory = fs.readdirSync(cache).find(entry => entry.startsWith(name + '@') && JSON.parse(fs.readFileSync(path.join(cache, entry, 'package.json'), 'utf8')).version === expected);
        if (!directory) throw new Error('Required already-cached package missing: ' + name);
        dependencies[name] = 'file:' + path.join(cache, directory).replaceAll('\\', '/');
    }
    fs.mkdirSync(path.join(project, 'Packages'));
    fs.writeFileSync(path.join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2));
}
if (!fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').includes('m_EditorVersion: ' + version + '\n')) throw new Error('Fixture Editor version differs');
const name = process.argv[2];
const prefix = '2026-10-08-cli-1.0.0-beta.12-editor-' + version + '-windows-x64-' + name;
const xml = path.join(__dirname, 'captures', prefix + '.xml');
const log = path.join(project, 'Logs', name + '.log');
const output = path.join(project, 'Build', 'Proof.exe');
const common = ['--non-interactive', '--no-log-proxy', '--no-banner', '--format', name === 'play-progress' ? 'ndjson' : 'json'];
const cases = {
    run: ['run', project, '--timeout', '180', '--log-file', log, '--', '-executeMethod', 'CliProof.Run', '-nographics'],
    'build-dirty': ['build', project, '--target', 'StandaloneWindows64', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '180'],
    build: ['build', project, '--target', 'StandaloneWindows64', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '180', '--allow-dirty-build'],
    'missing-module': ['build', project, '--target', 'Android', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '60', '--allow-dirty-build'],
    'registered-command': ['run', project, '--command', 'cli_proof', '--timeout', '60', '--log-file', log],
    'edit-pass': ['test', project, '--mode', 'EditMode', '--filter', 'CliEditTests.Passing', '--output', xml, '--timeout', '90', '--', '-nographics'],
    'edit-fail': ['test', project, '--mode', 'EditMode', '--filter', 'CliEditTests.DeliberateFailure', '--output', xml, '--timeout', '90', '--', '-nographics'],
    'play-pass': ['test', project, '--mode', 'PlayMode', '--filter', 'CliPlayTests.Passing', '--output', xml, '--timeout', '90', '--', '-nographics'],
    'play-progress': ['test', project, '--mode', 'PlayMode', '--filter', 'CliPlayTests.LongProgress', '--output', xml, '--timeout', '90', '--', '-nographics'],
    'test-timeout': ['test', project, '--mode', 'PlayMode', '--filter', 'CliPlayTests.LongProgress', '--output', xml, '--timeout', '10', '--', '-nographics']
};
cases['test-list'] = ['test', project, '--list'];
cases['run-timeout'] = [...cases.run];
cases['run-timeout'][cases['run-timeout'].indexOf('180')] = '15';
cases['run-timeout'][cases['run-timeout'].indexOf('CliProof.Run')] = 'CliProof.RunDelay';
cases['build-timeout'] = [...cases.build];
cases['build-timeout'][cases['build-timeout'].indexOf('180')] = '15';
cases['build-timeout'][cases['build-timeout'].indexOf('CliProof.Build')] = 'CliProof.RunDelay';
cases['test-cancel'] = [...cases['play-progress']];
cases['build-dirty-versioned'] = [...cases['build-dirty']];
cases['build-versioned'] = [...cases.build];
if (!cases[name]) throw new Error('Choose a defined proof case');
const args = cases[name];
const separator = args.indexOf('--');
args.splice(separator < 0 ? args.length : separator, 0, ...common);
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.mkdirSync(path.dirname(xml), { recursive: true });
function scrub(text) {
    text = (text || '').replaceAll(repo, '<repo>').replaceAll(repo.replaceAll('\\', '\\\\'), '<repo>').replaceAll(repo.replaceAll('\\', '/'), '<repo>').replaceAll(process.env.USERPROFILE || '<unused>', '<user>');
    for (const { root: editorRoot, label } of editorRoots) text = text.replaceAll(editorRoot, label).replaceAll(editorRoot.replaceAll('\\', '\\\\'), label).replaceAll(editorRoot.replaceAll('\\', '/'), label);
    for (const [input, label] of [[process.env.USERNAME, '<os-user>'], [process.env.COMPUTERNAME, '<host>']]) if (input) text = text.replaceAll(input, label);
    return text.replace(/^-hubSessionId\r?\n[^\r\n]*/gim, "<redacted credential or identity log line>")
        .replace(/^.*(?:licensing|SessionId|CorrelationId|MachineId|access[ -]?token|bearer|license[ -]?(?:serial|key|id)|hardware[ -]?id|user[ -]?id|account[ -]?id).*$/gim, "<redacted credential or identity log line>")
        .replace(/^\s*(?:Id|Product|Type|Expiration):[^\r\n]*$/gim, "<redacted licensing metadata>")
        .replace(/^\s*[A-Za-z0-9+\/=_-]{32,}\s*$/gm, "<redacted credential or identity log line>");
}
if (name === 'build-dirty-versioned' || name === 'build-versioned') { args.push('--versioning-strategy', 'semantic'); }
const beforeVersion = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8');
const startedAt = new Date().toISOString();
const started = Date.now();
const { spawn } = require('child_process');
const frames = [];
let interruptReceived = false;
process.on('SIGINT', () => { interruptReceived = true; });
const result = await new Promise(resolve => {
    const child = spawn(cli, args, { cwd: repo });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { const text = chunk.toString(); stdout += text; frames.push({ elapsedMs: Date.now() - started, stream: 'stdout', text: scrub(text) }); });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; frames.push({ elapsedMs: Date.now() - started, stream: 'stderr', text: scrub(text) }); });
    child.on('error', error => resolve({ status: null, error, stdout, stderr }));
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
});
const processes = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:UCT_CLI_PROOF_PROJECT) } | Select-Object -ExpandProperty ProcessId'], { encoding: 'utf8', env: { ...process.env, UCT_CLI_PROOF_PROJECT: project } });
if (processes.status !== 0) throw new Error('Owned Editor process query failed');
const packages = Object.entries(JSON.parse(fs.readFileSync(path.join(project, 'Packages/manifest.json'), 'utf8')).dependencies).filter(([, source]) => source.startsWith('file:')).map(([name, source]) => ({ name, version: JSON.parse(fs.readFileSync(path.join(source.slice(5), 'package.json'), 'utf8')).version, source: version === '6000.6.4f1' ? '<selected-editor>/Data/Resources/PackageManager/BuiltInPackages/' + name : '<sample-package-cache>/' + path.basename(source.slice(5)) }));
const capture = { redactions: ['repository/user roots', 'Editor roots from installed inventory', 'OS-user/host identifiers', 'credential/identity log lines'], interruptReceived, partialArtifactPresent: fs.existsSync(path.join(project, 'Temp/cli-proof-partial.txt')), packages, frames: frames.map(({ elapsedMs, stream, text }) => ({ elapsedMs, stream, characters: text.length, progressMarkers: /CLI_PROOF_PROGRESS/.test(text) ? text.match(/CLI_PROOF_PROGRESS \d+/g) : undefined })), leftoverEditorPids: processes.stdout.trim().split(/\s+/).filter(Boolean), startedAt, completedAt: new Date().toISOString(), cliVersion: '1.0.0-beta.12', editorVersion: version, platform: 'windows-x64', args: args.map(scrub), exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, error: result.error?.message, stdout: scrub(result.stdout), stderr: scrub(result.stderr), editorLog: fs.existsSync(log) ? scrub(fs.readFileSync(log, 'utf8')) : null, xmlProduced: fs.existsSync(xml), projectVersionBefore: beforeVersion, projectVersionAfter: fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'), declaredEditorVersionUnchanged: /^m_EditorVersion:\s*(\S+)/m.exec(beforeVersion)?.[1] === /^m_EditorVersion:\s*(\S+)/m.exec(fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1], buildArtifactPresentAfter: fs.existsSync(output) };
fs.writeFileSync(path.join(__dirname, 'captures', prefix + '.json'), JSON.stringify(capture, null, 2) + '\n');
console.log(JSON.stringify({ name, exitCode: capture.exitCode, durationMs: capture.durationMs, xmlProduced: capture.xmlProduced, buildArtifactPresentAfter: capture.buildArtifactPresentAfter, leftoverEditorPids: capture.leftoverEditorPids, frames: frames.length }));
if (capture.leftoverEditorPids.length) throw new Error('Owned fixture Editor remains; stop before another case');

})().catch(error => { console.error(error.message); process.exitCode = 1; });
