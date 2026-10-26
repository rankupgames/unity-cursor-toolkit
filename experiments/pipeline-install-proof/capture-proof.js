'use strict';
// Run after npm run compile. Uses only a new TEMP project and an explicit package pin.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const { UnityCliAdapter } = require('../../unity-cursor-toolkit/out/core/unityCliAdapter');
const { queryPipelineRegistry, evaluatePipelineEligibility } = require('../../unity-cursor-toolkit/out/core/pipelineEligibility');
const PIN = '0.8.0-exp.1', EDITOR = '6000.3.9f1';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const run = (binary, args) => new Promise((resolve, reject) => execFile(binary, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const evidence = { capturedAt: new Date().toISOString(), packageVersion: PIN, editorVersion: EDITOR, commands: [], outcome: 'incomplete' };
let fixture, editorPid, editorRoot, binaryPath, manifestBefore, lockBefore;

function withoutSecrets(value) {
    if (Array.isArray(value)) { return value.map(withoutSecrets); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([key]) => !/auth|credential|token|secret|password|bearer|email|foreignkey|username|userid|session/i.test(key)).map(([key, item]) => [key, withoutSecrets(item)]));
    }
    return value;
}
function scrub(value) {
    if (Array.isArray(value)) { return value.map(scrub); }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(withoutSecrets(value)).map(([key, item]) => [key, scrub(item)])); }
    if (typeof value !== 'string') { return value; }
    let text = value;
    const replacements = [[fixture, '<fixture>'], [editorRoot, '<editor-root>'], [binaryPath, '<cli-binary>'],
        [os.tmpdir(), '<temp-root>'], [os.homedir(), '<user-home>'], [process.env.LOCALAPPDATA, '<local-app-data>'],
        [process.env.APPDATA, '<app-data>'], [process.env.USERNAME, '<user>'], [os.hostname(), '<host>']].filter(pair => pair[0]);
    for (const [source, replacement] of replacements) {
        for (const form of [source, source.replace(/\\/g, '/'), JSON.stringify(source).slice(1, -1), JSON.stringify(JSON.stringify(source).slice(1, -1)).slice(1, -1)].sort((left, right) => right.length - left.length)) {
            text = text.split(form).join(replacement);
        }
    }
    text = text.replace(/[A-Z]:[\\/][^\r\n\"'<>]*?GiCache/g, '<gi-cache>').replace(/[A-Z]:[\\/][^\s\"'<>]*/g, '<absolute-path>');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-token>');
}
function scrubLog(value) {
    return scrub(value.replace(/^\s*-hubSessionId\r?\n[^\r\n]*/gim, '<credential line omitted>')
        .split(/\r?\n/).map(line => /licens|token|bearer|auth|user.?id|email|foreign.?key|serial.?number|machine.?id|session.?id|correlation.?id|hardware.?id|account.?id|^\s*(?:Id|Product|Type|Expiration):|^\s*[A-Za-z0-9+\/=_-]{32,}\s*$/i.test(line)
            ? '<licensing or credential line omitted>' : line).join('\n'));
}
function record(command, args, result) {
    const safe = { command, args, ok: result.ok, exitCode: result.exitCode, signal: result.signal, warnings: result.ok ? result.warnings : undefined,
        error: result.ok ? undefined : result.error };
    // Registered command listings contain public schema data, not CLI auth or recent logs.
    if (result.ok) { safe.data = result.data; }
    evidence.commands.push(scrub(safe));
    return result;
}
async function invoke(adapter, command, args, timeoutMs = 30000) {
    return record(command, args, await adapter.invoke(command, args, { timeoutMs, readOnly: false }));
}
function events() {
    const log = fs.existsSync(path.join(fixture, 'Editor.log')) ? fs.readFileSync(path.join(fixture, 'Editor.log'), 'utf8') : '';
    return [...log.matchAll(/\[PipelineInstallProof\] ([^\r\n]+)/g)].map(match => match[1]);
}
async function waitEvent(name, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline && alive(editorPid)) {
        if (events().some(event => event.startsWith(name + '|'))) { return; }
        await sleep(500);
    }
    throw new Error('Owned Editor did not reach ' + name + ' within the bound.');
}
function dependencyDelta(before, after) {
    return Object.keys({ ...before.dependencies, ...after.dependencies }).sort()
        .filter(key => JSON.stringify(before.dependencies?.[key]) !== JSON.stringify(after.dependencies?.[key]))
        .map(packageId => ({ packageId, before: before.dependencies?.[packageId] ?? null, after: after.dependencies?.[packageId] ?? null }));
}
function scopeInstances(data) {
    const rows = Array.isArray(data) ? data : data && typeof data === 'object'
        ? Object.values(data).find(Array.isArray) : null;
    if (!rows) { throw new Error('Pipeline discovery shape cannot be scoped without persisting unrelated instances.'); }
    return rows.filter(row => row && typeof row === 'object' && Object.values(row).some(value => typeof value === 'string' && path.normalize(value).toLowerCase() === fixture.toLowerCase()));
}

(async () => {
    const adapter = new UnityCliAdapter(process.env.UNITY_CLI_BINARY);
    const probe = await adapter.probe({ timeoutMs: 5000 });
    if (!probe.ok) { throw new Error('Pinned CLI probe refused: ' + probe.error.code); }
    binaryPath = probe.binaryPath; evidence.cliVersion = probe.data.version;
    const editors = await adapter.invoke('editors', ['-i'], { timeoutMs: 15000, readOnly: false });
    if (!editors.ok) { throw new Error('Installed Editor inventory failed: ' + editors.error.code); }
    const entries = Array.isArray(editors.data) ? editors.data : editors.data.editors;
    const selected = entries?.find(editor => editor.version === EDITOR);
    if (!selected?.location) { throw new Error('Exact Editor is unavailable; no fallback.'); }
    const executable = selected.location;
    editorRoot = path.dirname(path.dirname(executable));
    if (!fs.existsSync(executable)) { throw new Error('Exact Editor executable is missing.'); }
    evidence.editorArchitecture = selected.architecture;
    evidence.editorProductVersion = (await run('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath ' + psQuote(executable) + ').VersionInfo.ProductVersion'])).trim();
    if (!evidence.editorProductVersion.startsWith(EDITOR + '_')) { throw new Error('Installed Editor metadata does not match the exact declared version.'); }
    const versionsResult = await invoke(adapter, 'pipeline', ['list-versions']);
    if (!versionsResult.ok || !versionsResult.data.versions?.includes(PIN)) { throw new Error('Fresh CLI Pipeline inventory does not include the explicit pin.'); }
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-pipeline-proof-'));
    fs.mkdirSync(path.join(fixture, 'Assets', 'Editor'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'Packages'));
    fs.mkdirSync(path.join(fixture, 'ProjectSettings'));
    fs.copyFileSync(path.join(__dirname, 'fixture', 'Assets', 'Editor', 'PipelineInstallProof.cs'), path.join(fixture, 'Assets', 'Editor', 'PipelineInstallProof.cs'));
    fs.writeFileSync(path.join(fixture, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2));
    fs.writeFileSync(path.join(fixture, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + EDITOR + '\nm_EditorVersionWithRevision: ' + EDITOR + ' (7a9955a4f2fa)\n');
    // Query current publication metadata before the install writer. Persist only public package fields.
    const snapshot = await queryPipelineRegistry();
    const gate = evaluatePipelineEligibility(EDITOR, PIN, snapshot);
    const metadata = snapshot.metadata;
    evidence.registry = { url: snapshot.url, checkedAt: snapshot.checkedAt, httpDate: snapshot.httpDate,
        versions: Object.keys(metadata.versions).sort().map(version => ({ version, publishedAt: metadata.time[version], minimumEditor: metadata.versions[version].unity })),
        selected: { version: PIN, unity: metadata.versions[PIN]?.unity, dependencies: metadata.versions[PIN]?.dependencies } };
    evidence.eligibility = gate;
    if (!gate.ok) { throw new Error('Install gate refused: ' + gate.error.code); }
    const launch = '$p = Start-Process -FilePath ' + psQuote(executable)
        + ' -ArgumentList @(' + ["-projectPath", '"' + fixture + '"', "-logFile", '"' + path.join(fixture, 'Editor.log') + '"', "-silent-crashes"].map(psQuote).join(',')
        + ') -WindowStyle Hidden -PassThru; $p.Id';
    editorPid = Number((await run('powershell.exe', ['-NoProfile', '-Command', launch])).trim());
    if (!Number.isInteger(editorPid) || editorPid <= 0) { throw new Error('Owned Editor PID was not returned.'); }
    evidence.editorLaunchedAt = new Date().toISOString();
    await waitEvent('ready-baseline', 240000);
    const manifestPath = path.join(fixture, 'Packages', 'manifest.json'), lockPath = path.join(fixture, 'Packages', 'packages-lock.json');
    manifestBefore = readJson(manifestPath); lockBefore = readJson(lockPath);
    evidence.baseline = { manifest: manifestBefore, lock: lockBefore, events: events() };
    evidence.prelaunchEligibility = evidence.eligibility;
    const freshSnapshot = await queryPipelineRegistry();
    const freshGate = evaluatePipelineEligibility(EDITOR, PIN, freshSnapshot);
    evidence.registry.checkedAt = freshSnapshot.checkedAt; evidence.registry.httpDate = freshSnapshot.httpDate;
    evidence.registry.versions = Object.keys(freshSnapshot.metadata.versions).sort().map(version => ({ version, publishedAt: freshSnapshot.metadata.time[version], minimumEditor: freshSnapshot.metadata.versions[version].unity }));
    evidence.registry.selected = { version: PIN, unity: freshSnapshot.metadata.versions[PIN]?.unity, dependencies: freshSnapshot.metadata.versions[PIN]?.dependencies };
    evidence.eligibility = freshGate;
    if (!freshGate.ok) { throw new Error('Fresh install gate refused: ' + freshGate.error.code); }
    evidence.installStartedAt = new Date().toISOString();
    const install = await invoke(adapter, 'pipeline', ['install', '--project-path', fixture, '--package-version', PIN], 120000);
    evidence.installCompletedAt = new Date().toISOString();
    evidence.manifestDelta = dependencyDelta(manifestBefore, readJson(manifestPath));
    evidence.lockDelta = dependencyDelta(lockBefore, readJson(lockPath));
    if (!install.ok) { throw new Error('Explicit install failed: ' + install.error.code); }
    if (readJson(manifestPath).dependencies?.['com.unity.pipeline'] !== PIN) { throw new Error('Manifest does not contain the exact approved pin.'); }
    fs.writeFileSync(path.join(fixture, 'resolve.request'), '');
    await waitEvent('ready-installed', 180000);
    evidence.resolutionReadyAt = new Date().toISOString();
    evidence.manifestDelta = dependencyDelta(manifestBefore, readJson(manifestPath));
    evidence.lockDelta = dependencyDelta(lockBefore, readJson(lockPath));
    const status = await invoke(adapter, 'status', ['--project-path', fixture, '--until-ready', '--timeout', '60'], 90000);
    if (!status.ok) { throw new Error('Owned status failed: ' + status.error.code); }
    if (status.data.count !== 1 || status.data.instances?.length !== 1 || status.data.instances[0].project !== fixture || status.data.instances[0].pid !== editorPid || status.data.instances[0].version !== EDITOR || status.data.instances[0].state !== 'ready') { throw new Error('Status did not select the exact owned fixture.'); }
    // Global discovery is filtered in memory before recording; raw output is discarded.
    const discovery = await adapter.invoke('pipeline', ['list'], { timeoutMs: 30000, readOnly: false });
    if (!discovery.ok) { throw new Error('Pipeline discovery failed: ' + discovery.error.code); }
    const scoped = scopeInstances(discovery.data);
    evidence.commands.push(scrub({ command: 'pipeline', args: ['list'], ok: true, exitCode: discovery.exitCode, data: scoped, scope: 'exact owned fixture only' }));
    if (scoped.length !== 1) { throw new Error('Exactly one owned Pipeline instance was not discovered.'); }
    const list = await invoke(adapter, 'list', ['--project-path', fixture]);
    if (!list.ok) { throw new Error('Owned command inventory failed: ' + list.error.code); }
    // Capture-only command: the observed full JSON tag is "command editor_status".
    // Do not broaden the production adapter's allowed command selection.
    const statusArgs = ['command', '--format', 'json', '--non-interactive', '--no-banner', '--no-log-proxy', '--project-path', fixture, 'editor_status'];
    const raw = await new Promise(resolve => execFile(binaryPath, statusArgs, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    let envelope;
    try { envelope = JSON.parse(raw.stdout); } catch { throw new Error('Captured editor_status is not complete JSON.'); }
    const valid = !raw.error && envelope?.success === true && envelope.command === 'command editor_status'
        && Array.isArray(envelope.errors) && envelope.errors.length === 0 && Array.isArray(envelope.warnings)
        && envelope.data?.result?.projectPath === fixture && envelope.data.result.unityVersion === EDITOR
        && envelope.data.result.compiling === false && envelope.data.result.domainReloadInProgress === false;
    evidence.commands.push(scrub({ command: 'command', args: statusArgs.slice(6), observedCommand: envelope.command,
        ok: valid, exitCode: raw.error ? raw.error.code : 0, stdout: JSON.stringify(scrub(envelope)), stderr: scrubLog(raw.stderr), data: envelope.data }));
    if (!valid) { throw new Error('Owned editor_status full envelope or target did not validate.'); }
    evidence.outcome = 'passed';
})().catch(error => {
    evidence.failure = scrub(error.message); console.error('Pipeline proof: ' + evidence.failure);
}).finally(async () => {
    if (fixture && editorPid && alive(editorPid)) {
        fs.writeFileSync(path.join(fixture, 'quit.request'), '');
        const deadline = Date.now() + 30000;
        while (alive(editorPid) && Date.now() < deadline) { await sleep(500); }
        evidence.processExitObserved = !alive(editorPid);
    } else { evidence.processExitObserved = editorPid ? !alive(editorPid) : null; }
    if (fixture) {
        if (manifestBefore) { evidence.manifestDelta = dependencyDelta(manifestBefore, readJson(path.join(fixture, 'Packages', 'manifest.json'))); evidence.lockDelta = dependencyDelta(lockBefore, readJson(path.join(fixture, 'Packages', 'packages-lock.json'))); }
        evidence.events = events();
        evidence.normalQuitMarkerObserved = evidence.events.some(event => event.startsWith('normal-exit|'));
        evidence.quittingCallbackObserved = evidence.events.some(event => event.startsWith('quitting|'));
        const logPath = path.join(fixture, 'Editor.log');
        const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        // Drop credential-bearing licensing/auth/user lines; preserve compilation and timing evidence.
        evidence.editorLog = scrubLog(log);
        evidence.compilationErrors = evidence.editorLog.split('\n').filter(line => /error CS\d+|Scripts have compiler errors|Compilation failed/i.test(line));
    }
    evidence.editorExitCode = null; // Start-Process does not retain the child's exit code in this recorder.
    evidence.normalExitConfirmed = evidence.processExitObserved === true && evidence.normalQuitMarkerObserved === true && evidence.quittingCallbackObserved === true;
    if (evidence.compilationErrors?.length || !evidence.normalExitConfirmed) { evidence.outcome = 'incomplete'; }
    const output = path.join(__dirname, 'results', evidence.capturedAt.replace(/[:.]/g, '-') + '-cli-1.0.0-beta.12-pipeline-' + PIN + '-editor-' + EDITOR + '-windows-x64.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(scrub(evidence), null, 2) + '\n');
    console.log(JSON.stringify({ outcome: evidence.outcome, normalExitConfirmed: evidence.normalExitConfirmed, compilationErrors: evidence.compilationErrors?.length, evidenceFile: path.relative(process.cwd(), output), fixture: fixture ? '<temporary owned project>' : undefined }));
    process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
});
