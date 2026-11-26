// Capture an installed CLI, or verify a fresh isolated official pin, without launching an Editor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const os = require('os');
const pin = '1.0.0-beta.12';
const releaseNotes = 'https://docs.unity.com/en-us/unity-cli/release-notes';
const cdn = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function response(url, method = 'GET', timeout = 20000) {
    const result = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!result.ok) throw new Error('official_distribution_unavailable');
    return result;
}
function ageProof(headers) {
    const checkedAt = new Date().toISOString();
    const lastModified = headers.get('last-modified');
    const serverDate = headers.get('date');
    const ageSeconds = Math.min(Date.parse(checkedAt), Date.parse(serverDate)) / 1000 - Date.parse(lastModified) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds < 7 * 86400) throw new Error('official_artifact_too_young_or_undated');
    return { checkedAt, lastModified, serverDate, ageSeconds };
}
function signature(binary) {
    const script = '$s=Get-AuthenticodeSignature -LiteralPath $env:UCT_BASELINE_BINARY; $h=[Security.Cryptography.SHA256]::Create(); @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;userPathHash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([Environment]::GetEnvironmentVariable("Path","User"))))).Replace("-","").ToLower()}|ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, UCT_BASELINE_BINARY: binary } });
    if (result.status !== 0) throw new Error('signature_verification_unavailable');
    const verified = JSON.parse(result.stdout);
    if (verified.status !== 'Valid' || !/(?:^|, )O=Unity Technologies SF(?:,|$)/.test(verified.subject || '') || !/^[a-f0-9]{64}$/.test(verified.userPathHash || '')) throw new Error('official_signature_invalid');
    return verified;
}
async function installFresh() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('fresh_capture_requires_windows_x64');
    const notesResponse = await response(releaseNotes);
    const notes = (await notesResponse.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const availableVersions = [...notes.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\s+(1\.0\.0-beta\.\d+)/g)].map(m => ({ version: m[4], date: new Date(m[1] + ' ' + m[2] + ', ' + m[3] + ' UTC').toISOString().slice(0, 10) })).filter((item, index, all) => all.findIndex(candidate => candidate.version === item.version) === index);
    const selected = availableVersions.find(item => item.version === pin);
    if (!selected) throw new Error('official_release_date_missing');
    const releaseDate = { checkedAt: new Date().toISOString(), serverDate: notesResponse.headers.get('date') };
    releaseDate.ageSeconds = (Math.min(Date.parse(releaseDate.checkedAt), Date.parse(releaseDate.serverDate)) - Date.parse(selected.date)) / 1000;
    if (!Number.isFinite(releaseDate.ageSeconds) || releaseDate.ageSeconds < 7 * 86400) throw new Error('official_release_too_young_or_undated');
    const manifestUrl = cdn + pin + '/latest.json';
    const manifestResponse = await response(manifestUrl);
    const manifestBody = await manifestResponse.text();
    const manifest = JSON.parse(manifestBody);
    const artifact = manifest.binaries?.['win32-x64'];
    if (manifest.version !== pin || artifact?.filename !== 'unity-windows-x64.exe' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 64 * 1024 * 1024) throw new Error('official_manifest_invalid');
    const binaryUrl = cdn + pin + '/' + artifact.filename;
    const head = await response(binaryUrl, 'HEAD');
    const age = ageProof(head.headers); // Recheck artifact age immediately before download, against local and HTTP clocks.
    if (Number(head.headers.get('content-length')) !== artifact.size) throw new Error('official_artifact_size_mismatch');
    const download = await response(binaryUrl, 'GET', 60000);
    const downloadAge = ageProof(download.headers);
    if (downloadAge.lastModified !== age.lastModified || Number(download.headers.get('content-length')) !== artifact.size) throw new Error('official_artifact_changed');
    const chunks = []; let size = 0;
    for await (const chunk of download.body) { size += chunk.length; if (size > artifact.size) throw new Error('official_artifact_size_mismatch'); chunks.push(chunk); }
    const binary = Buffer.concat(chunks);
    if (size !== artifact.size || digest(binary) !== artifact.sha256) throw new Error('official_artifact_integrity_mismatch');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-cli-baseline-'));
    const cli = path.join(directory, 'unity.exe');
    try {
        fs.writeFileSync(cli, binary, { flag: 'wx' });
        const verified = signature(cli);
        return { cli, directory, userPathHash: verified.userPathHash, release: { date: selected.date, source: releaseNotes, installTimeAgeVerified: true, releaseDate, availableVersions, installation: { method: 'isolated official standalone binary; no installer, PATH or receipt changes', installedAt: new Date().toISOString(), manifestUrl, manifestSha256: digest(manifestBody), binaryUrl, binarySize: size, binarySha256: artifact.sha256, age, downloadAge, signature: { status: verified.status, subject: verified.subject } } } };
    } catch (error) { removeFresh(directory); throw error; }
}
function removeFresh(directory) {
    const target = path.resolve(directory), parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('uct-cli-baseline-') || fs.lstatSync(target).isSymbolicLink()) throw new Error('temporary_cleanup_refused');
    fs.rmSync(target, { recursive: true });
}
function userState() {
    const hub = path.join(process.env.APPDATA, 'UnityHub');
    return Object.fromEntries(fs.existsSync(hub) ? fs.readdirSync(hub).sort().filter(name => !/^accounts\.db(?:-wal|-shm)?$/.test(name) && fs.lstatSync(path.join(hub, name)).isFile()).map(name => [name, digest(fs.readFileSync(path.join(hub, name)))]) : []);
}
async function main() {
const fresh = process.argv.includes('--fresh-install');
if (process.argv.slice(2).some(arg => arg !== '--fresh-install')) throw new Error('unsupported_capture_argument');
const installed = fresh ? await installFresh() : null;
try {
const cli = installed?.cli || process.env.UNITY_CLI_BINARY || 'unity';
if (!fs.existsSync(cli)) throw new Error('Set UNITY_CLI_BINARY to the exact installed executable for checksum capture');
const root = path.resolve(__dirname, '../..');
const env = { ...process.env };
if (fresh) {
    for (const name of ['UNITY_NO_UPDATE_CHECK', 'UNITY_NO_CRASH_REPORT', 'UNITY_NO_CONSENT_PROMPT', 'UNITY_NO_EDITOR_IDENTITY_SERVER', 'UNITY_NO_AUTH_BROKER']) env[name] = '1';
    for (const name of ['UNITY_SERVICE_ACCOUNT_ID', 'UNITY_SERVICE_ACCOUNT_SECRET']) delete env[name];
}
const stateBefore = fresh ? userState() : null;
function invoke(args) {
    const start = Date.now();
    return { ...spawnSync(cli, [...args, '--no-log-proxy', '--non-interactive', '--no-banner'], { cwd: fresh ? installed.directory : root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }), durationMs: Date.now() - start };
}
const version = invoke(['--version']);
if (version.status !== 0 || version.stdout.trim() !== pin) throw new Error('Expected installed CLI 1.0.0-beta.12');
const inventoryResult = invoke(['editors', '-i', '--format', 'json']);
if (inventoryResult.status !== 0) throw new Error('Cannot resolve installed Editor roots');
const editorRoots = JSON.parse(inventoryResult.stdout).data.map(editor => ({ root: path.dirname(editor.location), label: '<editor:' + editor.version + '>' }));
const environmentResult = invoke(['env', '--format', 'json']);
if (environmentResult.status !== 0) throw new Error('Cannot resolve Editor installation root');
const installationRoot = JSON.parse(environmentResult.stdout).data.editorInstallPath;
if (typeof installationRoot !== 'string' || !installationRoot) throw new Error('Missing Editor installation root');
editorRoots.push({ root: installationRoot, label: '<editors>' });
if (fresh) editorRoots.push({ root: installed.directory, label: '<isolated-cli>' });
function scrubRoots(value) {
    for (const { root: editorRoot, label } of editorRoots) value = value.replaceAll(editorRoot, label).replaceAll(editorRoot.replaceAll('\\', '\\\\'), label).replaceAll(editorRoot.replaceAll('\\', '/'), label);
    for (const [input, label] of [[process.env.USERNAME, '<os-user>'], [process.env.COMPUTERNAME, '<host>']]) if (input) value = value.replaceAll(input, label);
    return value;
}
function scrub(value, key = '') {
    if (typeof value === 'string') {
        if (/token|secret|password|serial|email|username|displayname|userid|accountid|foreignkey/i.test(key)) return '<redacted>';
        return scrubRoots(value.replaceAll(root, '<repo>').replaceAll(root.replaceAll('\\', '\\\\'), '<repo>')
            .replaceAll(process.env.USERPROFILE || '<unused>', '<user>')
            .replaceAll((process.env.USERPROFILE || '<unused>').replaceAll('\\', '\\\\'), '<user>')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
            .replace(/^(?:recentLog\.\d+).*\n?/gm, '')
            .replace(/^(auth\.(?:name|serviceAccountClientId)\t).*$/gm, '$1<redacted>')
            .replace(/Unity-auth-broker-[^\s\t"']+/g, 'Unity-auth-broker-<user>')
            .replace(/^-hubSessionId\r?\n[^\r\n]*/gim, '<redacted credential or identity log line>')
            .replace(/^.*(?:licensing|Session[ -]?Id|Correlation[ -]?Id|Machine[ -]?Id|access[ -]?token|bearer|license[ -]?(?:serial|key|id)|hardware[ -]?id|user[ -]?id|account[ -]?id).*$/gim, '<redacted credential or identity log line>')
            .replace(/^\s*(?:Id|Product|Type|Expiration):[^\r\n]*$/gim, '<redacted licensing metadata>')
            .replace(/^\s*[A-Za-z0-9+\/=_-]{32,}\s*$/gm, '<redacted credential or identity log line>'));
    }
    if (Array.isArray(value)) return value.map(item => scrub(item));
    if (key === 'user' && value && typeof value === 'object') value = { ...value, name: '<redacted>' };
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    return value;
}
function output(value) {
    try { return JSON.stringify(scrub(JSON.parse(value)), null, value.trim().includes('\n') ? 2 : undefined) + '\n'; } catch { return scrub(value); }
}
const commands = fresh ? [['--version'], ['doctor'], ['env', '--format', 'json'], ['editors', '-i', '--format', 'json'], ['auth', 'status', '--format', 'json']] : [
    ['--version'], ['version', '--format', 'json'], ['doctor'], ['env', '--format', 'json'],
    ['editors', '-i', '--format', 'json'], ['auth', 'status', '--format', 'json'],
    ...['', 'editors', 'open', 'build', 'run', 'test', 'pipeline', 'command', 'list', 'status', 'mcp', 'commands', 'editors module list', 'skill show'].map(command => [...command.split(' ').filter(Boolean), '--help']),
    ['editors', '-i'], ...['json', 'ndjson', 'human', 'tsv', 'github'].map(format => ['version', '--format', format]),
    ['__invalid_capture_command__', '--format', 'json'], ['version', '--invalid-capture-option', '--format', 'json'],
    ['editors', 'module', 'list', '6000.6.4f1', '--format', 'json'],
    ['editors', 'module', 'list', '6000.3.9f1', '--format', 'json']
];
const cached = new Map([['--version', version], ['editors -i --format json', inventoryResult], ['env --format json', environmentResult]]);
const records = commands.map(args => {
    const result = (fresh && cached.get(args.join(' '))) || invoke(args);
    return { args, exitCode: result.status, signal: result.signal, durationMs: result.durationMs, error: result.error?.code, stdout: output(result.stdout || ''), stderr: output(result.stderr || '') };
});
const statePreserved = !fresh || (JSON.stringify(userState()) === JSON.stringify(stateBefore) && signature(cli).userPathHash === installed.userPathHash);
if (!statePreserved) throw new Error('diagnostic_profile_state_changed');
const capture = { capturedAt: new Date().toISOString(), cliVersion: version.stdout.trim(), platform: process.platform, architecture: process.arch, binarySha256: fs.existsSync(cli) ? crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex') : null, release: installed?.release || { date: '2026-09-30', source: releaseNotes, installTimeAgeVerified: false }, redactions: ['user path', 'repository path', 'Editor roots from inventory and env', 'account identifiers and credential fields', 'OS-user and host identifiers', 'doctor recent logs omitted'], records };
if (fresh) capture.isolation = { profileRegularFilesChecked: Object.keys(stateBefore).length, profileRegularFilesUnchanged: true, userPathUnchanged: true, accountStore: 'Not inspected; auth status may update account cache/WAL. accounts.db, accounts.db-wal and accounts.db-shm excluded from the file comparison. No authentication mutation command issued.', backgroundHelpersDisabled: ['update check', 'crash reporting', 'consent prompt', 'Editor identity server', 'auth broker'], logs: 'Documented diagnostic log writes are permitted; log directories excluded from state comparison.', historicalBinaryDifference: 'Same CLI version, different checksum and length from the 2026-10-08 binary; reason unknown.' };
const destination = path.join(__dirname, fresh ? 'captures/' + capture.capturedAt.slice(0, 10) + '-cli-' + pin + '-windows-x64-fresh-install.json' : 'captures/2026-10-08-cli-1.0.0-beta.12-windows-x64.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(records.map(({ args, exitCode, durationMs, error }) => ({ args, exitCode, durationMs, error }))));
} finally { if (installed) removeFresh(installed.directory); }
}
main().catch(error => { console.error(error.message && /^[A-Za-z0-9_ ]+$/.test(error.message) ? error.message : 'capture_failed'); process.exitCode = 1; });
