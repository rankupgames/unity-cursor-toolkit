// Execute one bounded case only in the owned exact-version fixture.
(async () => {
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const repo = path.resolve(__dirname, '../..');
const cli = process.env.UNITY_CLI_BINARY;
if (!cli || !path.isAbsolute(cli) || !fs.existsSync(cli)) throw new Error('Set UNITY_CLI_BINARY to the exact installed executable');
const version = process.env.UNITY_CLI_PROOF_EDITOR || '6000.6.4f1';
if (!['6000.3.9f1', '6000.6.4f1'].includes(version)) throw new Error('Use a recorded exact Editor version');
const name = process.argv[2];
if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Choose a defined proof case');
const nativeModuleCase = name === 'missing-module-native' || name === 'missing-module-profile' || name === 'missing-module-profile-build';
if (nativeModuleCase && version !== '6000.6.4f1') throw new Error('Use the recorded Editor with Android absent');
const prefix = new Date().toISOString().slice(0, 10) + '-cli-1.0.0-beta.12-editor-' + version + '-windows-x64-' + name;
const destination = path.join(__dirname, 'captures', prefix + '.json');
const xml = path.join(__dirname, 'captures', prefix + '.xml');
if (fs.existsSync(destination) || fs.existsSync(xml)) throw new Error('Proof capture already exists; historical evidence will not be overwritten');
const env = { ...process.env };
delete env.UNITY_EDITOR_VERSION;
for (const key of ['UNITY_SERVICE_ACCOUNT_ID', 'UNITY_SERVICE_ACCOUNT_SECRET']) delete env[key];
for (const key of ['UNITY_NO_UPDATE_CHECK', 'UNITY_NO_CRASH_REPORT', 'UNITY_NO_CONSENT_PROMPT', 'UNITY_NO_EDITOR_IDENTITY_SERVER', 'UNITY_NO_AUTH_BROKER']) env[key] = '1';
env.UNITY_INSTALL_MISSING_TOOLS = '0';
const cliVersion = spawnSync(cli, ['--version'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== '1.0.0-beta.12') throw new Error('CLI version differs');
const inventoryResult = spawnSync(cli, ['editors', '-i', '--format', 'json', '--no-log-proxy', '--non-interactive'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
if (inventoryResult.status !== 0) throw new Error('Cannot resolve installed Editor roots');
const installedEditors = JSON.parse(inventoryResult.stdout).data;
const editorRoots = installedEditors.map(editor => ({ root: path.dirname(editor.location), label: '<editor:' + editor.version + '>' }));
const moduleEvidence = [];
if (nativeModuleCase) {
    for (const editorVersion of ['6000.3.9f1', version]) {
        const result = spawnSync(cli, ['editors', 'module', 'list', editorVersion, '--format', 'json', '--no-log-proxy', '--non-interactive', '--no-banner'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
        if (result.status !== 0) throw new Error('Exact Editor module inventory failed');
        const status = JSON.parse(result.stdout).data.find(module => module.id === 'android')?.status;
        if (status !== (editorVersion === version ? 'Available' : 'Installed')) throw new Error('Recorded per-Editor Android module precondition differs');
        moduleEvidence.push({ args: ['editors', 'module', 'list', editorVersion, '--format', 'json'], exitCode: result.status, editorVersion, module: 'android', status });
    }
}
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
const log = path.join(project, 'Logs', prefix + '.log');
const output = path.join(project, 'Build', nativeModuleCase ? prefix + '.apk' : 'Proof.exe');
if (nativeModuleCase && !fs.existsSync(path.join(project, 'Assets/Proof.unity'))) throw new Error('Owned prepared fixture scene missing');
let nativeProfile;
if (name === 'missing-module-profile-build') {
    const prerequisite = JSON.parse(fs.readFileSync(path.join(__dirname, 'captures', prefix.replace(/missing-module-profile-build$/, 'missing-module-profile') + '.json'), 'utf8'));
    const result = JSON.parse(prerequisite.stdout);
    if (prerequisite.exitCode !== 0 || prerequisite.signal || prerequisite.error || result.success !== true || result.data?.target !== 'Android' || typeof result.data.profilePath !== 'string') throw new Error('Successful native Android profile prerequisite missing');
    nativeProfile = path.resolve(project, result.data.profilePath);
    const relative = path.relative(project, nativeProfile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !nativeProfile.endsWith('.asset') || !fs.existsSync(nativeProfile)) throw new Error('Native profile is not an existing owned project asset');
}
const common = ['--non-interactive', '--no-log-proxy', '--no-banner', '--format', name === 'play-progress' ? 'ndjson' : 'json'];
const cases = {
    run: ['run', project, '--timeout', '180', '--log-file', log, '--', '-executeMethod', 'CliProof.Run', '-nographics'],
    'build-dirty': ['build', project, '--target', 'StandaloneWindows64', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '180'],
    build: ['build', project, '--target', 'StandaloneWindows64', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '180', '--allow-dirty-build'],
    'missing-module': ['build', project, '--target', 'Android', '--execute-method', 'CliProof.Build', '--output-path', output, '--log-file', log, '--timeout', '60', '--allow-dirty-build'],
    'missing-module-native': ['build', project, '--target', 'Android', '--output-path', output, '--log-file', log, '--timeout', '60', '--allow-dirty-build', '--no-provenance', '--no-accelerator'],
    'missing-module-profile': ['build', project, '--create-profile', 'Android', '--log-file', log, '--timeout', '60', '--no-provenance', '--no-accelerator'],
    'missing-module-profile-build': ['build', project, '--profile', nativeProfile, '--output-path', output, '--log-file', log, '--timeout', '60', '--allow-dirty-build', '--no-provenance', '--no-accelerator'],
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
        .replace(/^.*(?:licensing|Session[ -]?Id|Correlation[ -]?Id|Machine[ -]?Id|access[ -]?token|bearer|license[ -]?(?:serial|key|id)|hardware[ -]?id|user[ -]?id|account[ -]?id).*$/gim, "<redacted credential or identity log line>")
        .replace(/^\s*(?:Id|Product|Type|Expiration):[^\r\n]*$/gim, "<redacted diagnostic>")
        .replace(/^\s*[A-Za-z0-9+\/=_-]{32,}\s*$/gm, "<redacted credential or identity log line>");
}
if (name === 'build-dirty-versioned' || name === 'build-versioned') { args.push('--versioning-strategy', 'semantic'); }
const beforeVersion = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8');
function ownedEditors() {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:UCT_CLI_PROOF_PROJECT) } | Select-Object -ExpandProperty ProcessId'], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true, env: { ...env, UCT_CLI_PROOF_PROJECT: project } });
    if (result.status !== 0) throw new Error('Owned Editor process query failed');
    return result.stdout.trim().split(/\s+/).filter(Boolean);
}
if (nativeModuleCase && ownedEditors().length) throw new Error('Owned fixture already has an Editor; stop before another case');
const startedAt = new Date().toISOString();
const started = Date.now();
const { spawn } = require('child_process');
const frames = [];
let interruptReceived = false;
process.on('SIGINT', () => { interruptReceived = true; });
const result = await new Promise(resolve => {
    const child = spawn(cli, args, { cwd: repo, env, windowsHide: true, timeout: nativeModuleCase ? 90000 : undefined });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { const text = chunk.toString(); stdout += text; frames.push({ elapsedMs: Date.now() - started, stream: 'stdout', text: scrub(text) }); });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; frames.push({ elapsedMs: Date.now() - started, stream: 'stderr', text: scrub(text) }); });
    child.on('error', error => resolve({ status: null, error, stdout, stderr }));
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
});
const leftoverEditorPids = ownedEditors();
const packages = Object.entries(JSON.parse(fs.readFileSync(path.join(project, 'Packages/manifest.json'), 'utf8')).dependencies).filter(([, source]) => source.startsWith('file:')).map(([name, source]) => ({ name, version: JSON.parse(fs.readFileSync(path.join(source.slice(5), 'package.json'), 'utf8')).version, source: version === '6000.6.4f1' ? '<selected-editor>/Data/Resources/PackageManager/BuiltInPackages/' + name : '<sample-package-cache>/' + path.basename(source.slice(5)) }));
const capture = { redactions: ['repository/user roots', 'Editor roots from installed inventory', 'OS-user/host identifiers', 'credential/identity log lines'], interruptReceived, partialArtifactPresent: fs.existsSync(path.join(project, 'Temp/cli-proof-partial.txt')), packages, frames: frames.map(({ elapsedMs, stream, text }) => ({ elapsedMs, stream, characters: text.length, progressMarkers: /CLI_PROOF_PROGRESS/.test(text) ? text.match(/CLI_PROOF_PROGRESS \d+/g) : undefined })), leftoverEditorPids, startedAt, completedAt: new Date().toISOString(), cliVersion: '1.0.0-beta.12', binarySha256: require('crypto').createHash('sha256').update(fs.readFileSync(cli)).digest('hex'), installedEditorVersions: installedEditors.map(editor => editor.version), moduleEvidence, editorVersion: version, platform: 'windows-x64', args: args.map(scrub), exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, error: result.error?.code, stdout: scrub(result.stdout), stderr: scrub(result.stderr), editorLog: fs.existsSync(log) ? scrub(fs.readFileSync(log, 'utf8')) : null, xmlProduced: fs.existsSync(xml), projectVersionBefore: beforeVersion, projectVersionAfter: fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'), declaredEditorVersionUnchanged: /^m_EditorVersion:\s*(\S+)/m.exec(beforeVersion)?.[1] === /^m_EditorVersion:\s*(\S+)/m.exec(fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1], buildArtifactPresentAfter: fs.existsSync(output) };
fs.writeFileSync(destination, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ name, exitCode: capture.exitCode, durationMs: capture.durationMs, xmlProduced: capture.xmlProduced, buildArtifactPresentAfter: capture.buildArtifactPresentAfter, leftoverEditorPids: capture.leftoverEditorPids, frames: frames.length }));
if (capture.leftoverEditorPids.length) throw new Error('Owned fixture Editor remains; stop before another case');

})().catch(error => { console.error(error.code || (error.message && /^[A-Za-z0-9 _;:-]+$/.test(error.message) ? error.message : 'proof_capture_failed')); process.exitCode = 1; });
