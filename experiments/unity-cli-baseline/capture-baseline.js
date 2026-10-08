// Capture the installed CLI without installing packages or launching an Editor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cli = process.env.UNITY_CLI_BINARY || 'unity';
if (!fs.existsSync(cli)) throw new Error('Set UNITY_CLI_BINARY to the exact installed executable for checksum capture');
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== '1.0.0-beta.12') throw new Error('Expected installed CLI 1.0.0-beta.12');
const root = path.resolve(__dirname, '../..');
const inventoryResult = spawnSync(cli, ['editors', '-i', '--format', 'json', '--no-log-proxy', '--non-interactive'], { encoding: 'utf8', timeout: 30000 });
if (inventoryResult.status !== 0) throw new Error('Cannot resolve installed Editor roots');
const editorRoots = JSON.parse(inventoryResult.stdout).data.map(editor => ({ root: path.dirname(editor.location), label: '<editor:' + editor.version + '>' }));
const environmentResult = spawnSync(cli, ['env', '--format', 'json', '--no-log-proxy', '--non-interactive'], { encoding: 'utf8', timeout: 30000 });
if (environmentResult.status !== 0) throw new Error('Cannot resolve Editor installation root');
const installationRoot = JSON.parse(environmentResult.stdout).data.editorInstallPath;
if (typeof installationRoot !== 'string' || !installationRoot) throw new Error('Missing Editor installation root');
editorRoots.push({ root: installationRoot, label: '<editors>' });
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
const commands = [
    ['--version'], ['version', '--format', 'json'], ['doctor'], ['env', '--format', 'json'],
    ['editors', '-i', '--format', 'json'], ['auth', 'status', '--format', 'json'],
    ...['', 'editors', 'open', 'build', 'run', 'test', 'pipeline', 'command', 'list', 'status', 'mcp', 'commands', 'editors module list', 'skill show'].map(command => [...command.split(' ').filter(Boolean), '--help']),
    ['editors', '-i'], ...['json', 'ndjson', 'human', 'tsv', 'github'].map(format => ['version', '--format', format]),
    ['__invalid_capture_command__', '--format', 'json'], ['version', '--invalid-capture-option', '--format', 'json'],
    ['editors', 'module', 'list', '6000.6.4f1', '--format', 'json'],
    ['editors', 'module', 'list', '6000.3.9f1', '--format', 'json']
];
const records = commands.map(args => {
    const start = Date.now();
    const result = spawnSync(cli, [...args, '--no-log-proxy', '--non-interactive', '--no-banner'], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return { args, exitCode: result.status, signal: result.signal, durationMs: Date.now() - start, error: result.error?.message, stdout: output(result.stdout || ''), stderr: output(result.stderr || '') };
});
const capture = { capturedAt: new Date().toISOString(), cliVersion: version.stdout.trim(), platform: process.platform, architecture: process.arch, binarySha256: fs.existsSync(cli) ? crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex') : null, release: { date: '2026-09-30', source: 'https://docs.unity.com/en-us/unity-cli/release-notes', installTimeAgeVerified: false }, redactions: ['user path', 'repository path', 'Editor roots from inventory and env', 'account identifiers and credential fields', 'OS-user and host identifiers', 'doctor recent logs omitted'], records };
const destination = path.join(__dirname, 'captures/2026-10-08-cli-1.0.0-beta.12-windows-x64.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(capture, null, 2) + '\n');
console.log(JSON.stringify(records.map(({ args, exitCode, durationMs, error }) => ({ args, exitCode, durationMs, error }))));
