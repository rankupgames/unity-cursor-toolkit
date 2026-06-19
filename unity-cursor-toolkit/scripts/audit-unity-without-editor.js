#!/usr/bin/env node
/**
 * Audits the current "Unity Without The Editor" experiment evidence.
 *
 * This is intentionally a product/experiment acceptance audit, not a runtime
 * renderer. It fails missing or contradictory evidence, and reports known
 * Windows proof gaps as pending unless --strict is passed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const strict = hasFlag('--strict');
const jsonOnly = hasFlag('--json');
const outPath = getStringArg('--out', '');

const checks = [
	checkLegalBoundary,
	checkDllMountProbe,
	checkHiddenEditorSpike,
	checkEditorStreamSampler,
	checkViewportCommands,
	checkInstalledCursorSmoke,
	checkInstalledCursorUiProof,
	checkInstalledCursorAutomatedFrameProof,
	checkUnityEditorWindowCapture,
	checkViewportServicePlayerLane,
	checkPlayerPerf,
	checkLicenseAutomation,
	checkWindowsGate
];

const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	platform: process.platform,
	osRelease: os.release(),
	nodeVersion: process.version,
	strict,
	status: 'unknown',
	counts: {
		pass: 0,
		pending: 0,
		fail: 0
	},
	checks: []
};

for (const check of checks) {
	const result = runCheck(check);
	report.checks.push(result);
	report.counts[result.status]++;
}

report.status = report.counts.fail > 0
	? 'fail'
	: report.counts.pending > 0
		? 'partial'
		: 'pass';

if (outPath) {
	writeJson(path.resolve(outPath), report);
}

if (jsonOnly) {
	process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
	printHumanReport(report);
}

if (report.counts.fail > 0 || (strict && report.counts.pending > 0)) {
	process.exitCode = 1;
}

function checkLegalBoundary() {
	const doc = readText('docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md');
	const prompt = readText('docs/prompts/unity-without-editor-agent-prompt.md');
	requireIncludes(doc, 'never Unity\'s private native state or a forged icall table');
	requireIncludes(doc, 'DLL mounting is not a viable editor-rendering lane');
	requireIncludes(doc, 'No editor seat at runtime');
	requireIncludes(prompt, 'Never patch, spoof, proxy, hook, or bypass Unity license checks');
	return pass('legal-boundary', 'Docs preserve the no-EULA-bypass boundary and the legal player-runtime lane.', [
		'docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md',
		'docs/prompts/unity-without-editor-agent-prompt.md'
	]);
}

function checkDllMountProbe() {
	const resultPath = 'experiments/editor-dll-mount-probe/results/2026-06-10-6000.3.9f1-macos.json';
	const result = readJson(resultPath);
	requireIncludes(String(result.verdict || ''), 'DLL mounting is NOT a viable editor-rendering lane');
	requireArray(result.probes, 'probes');
	return pass('e1-dll-mount-probe', 'macOS DLL-mount probe confirms managed wrappers only; editor rendering requires the official editor boot path.', [
		resultPath,
		'experiments/editor-dll-mount-probe/Program.cs'
	]);
}

function checkHiddenEditorSpike() {
	const resultPath = 'experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-warm-spike-result.json';
	const result = readJson(resultPath);
	if (result.success !== true || result.allCapturesSucceeded !== true) {
		throw new Error('hidden editor spike did not record full capture success');
	}
	requireArray(result.captures, 'captures');
	if (result.captures.length < 5) {
		throw new Error(`expected at least 5 editor-window captures; found ${result.captures.length}`);
	}
	if (result.inputTest?.changed !== true) {
		throw new Error('SceneView input test did not record a rotation change');
	}
	return pass('e2-hidden-editor-spike', 'Hidden installed editor captured real Scene/Game/Inspector/Package/custom EditorWindow pixels and accepted SceneView input.', [
		resultPath,
		'CursorUnityTool/Assets/Editor/UCTEditorWindowCaptureSpike.cs'
	]);
}

function checkEditorStreamSampler() {
	const measurePath = 'experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-scene-12fps-stream-measure.json';
	const livePath = 'experiments/hidden-editor-cost-baseline/results/2026-06-10-6000.3.9f1-macos-cursor-live-stream-sample.json';
	const measure = readJson(measurePath);
	if (measure.view !== 'scene' || measure.captureMode !== 'editorWindow') {
		throw new Error('editor stream measure is not a Scene editorWindow stream');
	}
	if (!Number.isFinite(measure.frameCount) || measure.frameCount < 1) {
		throw new Error('editor stream measure has no frames');
	}
	readJson(livePath);
	return pass('e2-editor-stream-measure', 'Editor-window stream sampling exists and captured live Scene View frames through the toolkit bridge.', [
		measurePath,
		livePath,
		'unity-cursor-toolkit/scripts/measure-editor-streaming.js'
	]);
}

function checkViewportCommands() {
	const packageJson = readJson('unity-cursor-toolkit/package.json');
	const viewport = readText('unity-cursor-toolkit/src/viewport/index.ts');
	for (const command of expectedViewportCommands()) {
		if (!JSON.stringify(packageJson).includes(command) || !viewport.includes(command)) {
			throw new Error(`missing viewport command contribution or registration: ${command}`);
		}
	}
	requireIncludes(viewport, 'this.openView(\'scene\', \'editor\')');
	requireIncludes(viewport, 'this.openView(\'game\', \'editor\')');
	requireIncludes(viewport, 'this.openView(\'scene\', \'player\')');
	requireIncludes(viewport, 'this.openView(\'game\', \'player\')');
	requireIncludes(viewport, 'host: this.host');
	requireIncludes(viewport, 'captureMode: this.host === \'player\' ? \'camera\' : \'editorWindow\'');
	return pass('cursor-viewport-commands', 'Cursor extension contributes editor Scene/Game and separate player Scene/Game panels with the expected host/capture modes.', [
		'unity-cursor-toolkit/package.json',
		'unity-cursor-toolkit/src/viewport/index.ts'
	]);
}

function checkInstalledCursorSmoke() {
	const packageJson = readJson('unity-cursor-toolkit/package.json');
	if (!packageJson.scripts?.['smoke:installed-cursor-viewports']) {
		throw new Error('missing smoke:installed-cursor-viewports package script');
	}
	const resultPath = 'experiments/installed-cursor-smoke/results/2026-06-10-isolated-install.json';
	const result = readJson(resultPath);
	if (result.status !== 'pass') {
		throw new Error(`installed Cursor smoke did not pass: ${result.status}`);
	}
	if (Array.isArray(result.installedExtensions) === false || result.installedExtensions.some(line => /^rankupgames\.unity-cursor-toolkit@/.test(line)) === false) {
		throw new Error('isolated Cursor extension list did not include rankupgames.unity-cursor-toolkit');
	}
	const commands = Array.isArray(result.commandManifest) ? result.commandManifest : [];
	const missing = expectedViewportCommands().filter(command => commands.includes(command) === false);
	if (missing.length > 0) {
		throw new Error(`installed Cursor smoke result is missing viewport commands: ${missing.join(', ')}`);
	}
	return pass('installed-cursor-smoke', 'Packaged VSIX installs into an isolated Cursor profile and exposes the viewport command surface.', [
		resultPath,
		'unity-cursor-toolkit/scripts/smoke-installed-cursor-viewports.js'
	]);
}

function checkInstalledCursorUiProof() {
	const resultPath = 'experiments/installed-cursor-smoke/results/2026-06-10-installed-editor-scene-game-ui.json';
	const result = readJson(resultPath);
	if (result.status !== 'pass') {
		throw new Error(`installed Cursor UI proof did not pass: ${result.status}`);
	}
	if (result.unity?.bridgePort !== 55500 || !String(result.unity?.process || '').includes('Unity.app/Contents/MacOS/Unity')) {
		throw new Error('installed Cursor UI proof does not reference the official Unity editor bridge on 55500');
	}
	if (!String(result.editorPanels?.sceneView?.statusText || '').startsWith('Live frame')) {
		throw new Error('installed Cursor UI proof is missing live Scene View frame evidence');
	}
	if (!String(result.editorPanels?.gameView?.statusText || '').startsWith('Live frame')) {
		throw new Error('installed Cursor UI proof is missing live Game View frame evidence');
	}
	const screenshotPath = result.screenshot?.path;
	if (typeof screenshotPath !== 'string' || fs.existsSync(resolveRepoPath(screenshotPath)) === false) {
		throw new Error('installed Cursor UI proof screenshot is missing');
	}
	return pass('installed-cursor-editor-ui-proof', 'Installed Cursor opened editor Scene/Game panels and rendered live frames through the official hidden Unity editor bridge.', [
		resultPath,
		screenshotPath
	]);
}

function checkInstalledCursorAutomatedFrameProof() {
	const smokePath = 'experiments/installed-cursor-smoke/results/2026-06-10-interactive-smoke.json';
	const proofPath = 'experiments/installed-cursor-smoke/results/2026-06-10-interactive-proof.json';
	const smoke = readJson(smokePath);
	const proof = readJson(proofPath);
	if (smoke.status !== 'pass') {
		throw new Error(`installed Cursor automated proof smoke did not pass: ${smoke.status}`);
	}
	if (smoke.viewportProof?.result?.status !== 'pass') {
		throw new Error('installed Cursor automated smoke report does not embed a passing viewport proof');
	}
	if (proof.status !== 'pass' || proof.proofMode !== 'installed-cursor-editor-scene-game') {
		throw new Error(`installed Cursor automated proof did not pass: ${proof.status}`);
	}
	if (proof.extension?.id !== 'rankupgames.unity-cursor-toolkit') {
		throw new Error('installed Cursor automated proof did not run inside the packaged toolkit extension');
	}
	if (proof.connection?.state !== 'connected' || proof.connection?.port !== 55500) {
		throw new Error('installed Cursor automated proof was not connected to the official Unity editor bridge on 55500');
	}
	validateInstalledCursorProofPanel(proof.panels?.sceneView, 'scene');
	validateInstalledCursorProofPanel(proof.panels?.gameView, 'game');
	return pass('installed-cursor-editor-frame-proof', 'Installed Cursor auto-opened editor Scene/Game panels and archived live editorWindow frame hashes plus editor-window input proof from the packaged extension.', [
		smokePath,
		proofPath,
		'unity-cursor-toolkit/scripts/smoke-installed-cursor-viewports.js',
		'unity-cursor-toolkit/src/viewport/index.ts'
	], {
		sceneSequence: proof.panels.sceneView.frame.sequence,
		sceneWidth: proof.panels.sceneView.frame.width,
		sceneHeight: proof.panels.sceneView.frame.height,
		sceneInput: proof.panels.sceneView.inputProof.inputType,
		gameSequence: proof.panels.gameView.frame.sequence,
		gameWidth: proof.panels.gameView.frame.width,
		gameHeight: proof.panels.gameView.frame.height,
		gameInput: proof.panels.gameView.inputProof.inputType
	});
}

function validateInstalledCursorProofPanel(panel, expectedMode) {
	if (panel?.mode !== expectedMode) {
		throw new Error(`installed Cursor proof panel mode mismatch for ${expectedMode}`);
	}
	if (panel.host !== 'editor' || panel.captureMode !== 'editorWindow') {
		throw new Error(`installed Cursor ${expectedMode} proof is not an editorWindow stream`);
	}
	if (panel.connectionState !== 'connected' || panel.streaming !== true) {
		throw new Error(`installed Cursor ${expectedMode} proof is not connected/streaming`);
	}
	if (!String(panel.status || '').startsWith('Live frame')) {
		throw new Error(`installed Cursor ${expectedMode} proof is missing live frame status`);
	}
	const frame = panel.frame || {};
	if (!Number.isFinite(frame.sequence) || frame.sequence < 1) {
		throw new Error(`installed Cursor ${expectedMode} proof has no positive frame sequence`);
	}
	if (!Number.isFinite(frame.width) || frame.width < 1 || !Number.isFinite(frame.height) || frame.height < 1) {
		throw new Error(`installed Cursor ${expectedMode} proof has invalid frame dimensions`);
	}
	if (!Number.isFinite(frame.dataBytes) || frame.dataBytes < 1024) {
		throw new Error(`installed Cursor ${expectedMode} proof frame payload is too small`);
	}
	if (typeof frame.sha256 !== 'string' || /^[a-f0-9]{64}$/.test(frame.sha256) === false) {
		throw new Error(`installed Cursor ${expectedMode} proof frame hash is invalid`);
	}
	const inputProof = panel.inputProof || {};
	if (inputProof.success !== true || inputProof.layer !== 'editorWindow') {
		throw new Error(`installed Cursor ${expectedMode} proof did not verify editor-window input`);
	}
	if (typeof inputProof.inputType !== 'string' || inputProof.inputType.length === 0) {
		throw new Error(`installed Cursor ${expectedMode} proof is missing input proof type`);
	}
}

function checkUnityEditorWindowCapture() {
	const capture = readText('Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/EditorWindowViewportCapture.cs');
	const mirror = readText('CursorUnityTool/Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/EditorWindowViewportCapture.cs');
	const stream = readText('Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/ViewportStreamTool.cs');
	for (const source of [capture, mirror]) {
		requireIncludes(source, 'GrabPixels');
		requireIncludes(source, 'SceneView');
		requireIncludes(source, 'PackageManager');
		requireIncludes(source, 'SendEvent');
	}
	requireIncludes(stream, 'captureMode');
	requireIncludes(stream, 'host');
	return pass('real-editor-window-capture', 'Unity-side MCP package captures actual EditorWindow GUIViews and routes input through EditorWindow.SendEvent.', [
		'Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/EditorWindowViewportCapture.cs',
		'Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/ViewportStreamTool.cs'
	]);
}

function checkViewportServicePlayerLane() {
	const packageJson = readJson('unity-cursor-toolkit/package.json');
	const requiredScripts = [
		'build:viewport-service',
		'run:viewport-service',
		'probe:viewport-service',
		'measure:viewport-service'
	];
	for (const scriptName of requiredScripts) {
		if (!packageJson.scripts?.[scriptName]) {
			throw new Error(`missing package script ${scriptName}`);
		}
	}
	requireIncludes(readText('CursorUnityTool/Assets/ViewportService/ViewportServiceServer.cs'), 'viewport_stream');
	requireIncludes(readText('CursorUnityTool/Assets/Editor/ViewportServiceBuild.cs'), 'BuildPipeline.BuildPlayer');
	return pass('e3-player-viewport-service', 'Player Viewport Service build/run/probe/measure scripts and Unity runtime server are present.', [
		'CursorUnityTool/Assets/ViewportService/ViewportServiceServer.cs',
		'CursorUnityTool/Assets/Editor/ViewportServiceBuild.cs',
		'unity-cursor-toolkit/scripts/measure-viewport-service.js'
	]);
}

function checkPlayerPerf() {
	const resultPath = 'experiments/player-viewport-service/results/2026-06-10-6000.3.9f1-macos-game-1280x720-30fps.json';
	const result = readJson(resultPath);
	if (result.request?.host !== 'player' || result.request?.captureMode !== 'camera') {
		throw new Error('player perf result is not a player camera stream');
	}
	if (result.request?.width !== 1280 || result.request?.height !== 720 || result.request?.fps !== 30) {
		throw new Error('player perf result is not 1280x720@30');
	}
	if (!Number.isFinite(result.summary?.effectiveFps) || result.summary.effectiveFps < 25) {
		throw new Error(`player effective fps below audit threshold: ${result.summary?.effectiveFps}`);
	}
	if (Array.isArray(result.errors) === false || result.errors.length !== 0) {
		throw new Error('player perf result recorded errors');
	}
	return pass('e3-player-perf', 'macOS player lane has archived 1280x720@30 perf evidence with no runtime errors.', [
		resultPath
	], {
		effectiveFps: result.summary.effectiveFps,
		startupMs: result.summary.startupMs,
		timeToFirstFrameMs: result.summary.timeToFirstFrameMs
	});
}

function checkLicenseAutomation() {
	const packageJson = readJson('unity-cursor-toolkit/package.json');
	if (!packageJson.scripts?.['unity:license']) {
		throw new Error('missing unity:license package script');
	}
	const script = readText('unity-cursor-toolkit/scripts/unity-license.js');
	requireIncludes(script, '-createManualActivationFile');
	requireIncludes(script, '-manualLicenseFile');
	requireIncludes(script, '-username');
	requireIncludes(script, '-password');
	requireIncludes(script, '-serial');
	requireIncludes(script, 'dryRun');
	return pass('e5-license-automation', 'License automation wrapper uses official Unity activation/import flags and dry-run masking.', [
		'unity-cursor-toolkit/scripts/unity-license.js'
	]);
}

function checkWindowsGate() {
	const doc = readText('docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md');
	const packageJson = readJson('unity-cursor-toolkit/package.json');
	requireIncludes(doc, 'Windows remains a hard acceptance gate');
	requireIncludes(doc, 'Windows build/run/probe');
	if (!packageJson.scripts?.['proof:windows-unity-without-editor']) {
		throw new Error('missing proof:windows-unity-without-editor package script');
	}
	if (!packageJson.scripts?.['proof:windows-unity-without-editor:preflight']) {
		throw new Error('missing proof:windows-unity-without-editor:preflight package script');
	}
	if (!packageJson.scripts?.['proof:windows-unity-without-editor:remote']) {
		throw new Error('missing proof:windows-unity-without-editor:remote package script');
	}
	if (!packageJson.scripts?.['proof:windows-unity-without-editor:import']) {
		throw new Error('missing proof:windows-unity-without-editor:import package script');
	}
	readText('unity-cursor-toolkit/scripts/run-windows-unity-without-editor-proof.js');
	readText('unity-cursor-toolkit/scripts/run-remote-windows-unity-without-editor-proof.js');
	readText('unity-cursor-toolkit/scripts/import-windows-unity-without-editor-proof.js');
	const summaries = findWindowsProofSummaries();
	const proof = selectLatestExecutedWindowsProof(summaries);
	if (!proof) {
		return pending('windows-proof', 'Windows E1/E2/installed-Cursor/E3 installed-host proof is still pending and remains a required gate before the full series is complete.', [
			'docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md',
			'unity-cursor-toolkit/scripts/run-windows-unity-without-editor-proof.js',
			'unity-cursor-toolkit/scripts/run-remote-windows-unity-without-editor-proof.js',
			'unity-cursor-toolkit/scripts/import-windows-unity-without-editor-proof.js',
			...summaries.map((summary) => summary.relativePath)
		]);
	}
	const validation = validateWindowsProofSummary(proof);
	return pass('windows-proof', 'Windows E1/E2/installed-Cursor/E3 installed-host proof passed with official Unity editor capture, Cursor Scene/Game frame hashes, and player-lane evidence.', validation.evidence, validation.metrics);
}

function findWindowsProofSummaries() {
	const root = resolveRepoPath('experiments/windows-unity-without-editor/results');
	if (fs.existsSync(root) === false) {
		return [];
	}
	const found = [];
	walkFiles(root, (absolutePath) => {
		if (path.basename(absolutePath) === 'windows-proof-summary.json') {
			found.push({
				absolutePath,
				relativePath: toRepoRelative(absolutePath),
				mtimeMs: fs.statSync(absolutePath).mtimeMs
			});
		}
	});
	return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function selectLatestExecutedWindowsProof(summaries) {
	const loaded = summaries.map((summary) => ({
		...summary,
		summary: readJson(summary.relativePath)
	}));
	const executed = loaded.filter((proof) => proof.summary?.mode !== 'dry-run' && proof.summary?.status !== 'planned');
	if (executed.length === 0) {
		return null;
	}
	return executed.sort((a, b) => {
		const byTime = summaryTimestamp(b) - summaryTimestamp(a);
		return byTime || b.mtimeMs - a.mtimeMs || b.relativePath.localeCompare(a.relativePath);
	})[0];
}

function validateWindowsProofSummary(proof) {
	const summary = proof.summary;
	if (summary.schemaVersion !== 1) {
		throw new Error(`Windows proof summary has unsupported schemaVersion: ${summary.schemaVersion}`);
	}
	if (summary.mode !== 'execute') {
		throw new Error(`Windows proof summary is not an executed proof: ${summary.mode}`);
	}
	if (summary.platform !== 'win32' || summary.windowsHost !== true) {
		throw new Error(`Windows proof summary was not produced on a Windows host: ${summary.platform}`);
	}
	if (summary.status !== 'pass') {
		throw new Error(`latest Windows proof summary did not pass: ${summary.status}`);
	}
	for (const [name, value] of Object.entries(summary.options || {})) {
		if ((/^skipE[123]$/.test(name) || name === 'skipCursorProof') && value === true) {
			throw new Error(`latest Windows proof skipped required gate ${name}`);
		}
	}
	requireStep(summary, 'E1 DLL mount probe');
	requireStep(summary, 'E2 hidden editor-window capture spike');
	requireStep(summary, 'Installed Cursor automated editor Scene/Game frame proof');
	requireStep(summary, 'E3 build Viewport Service Windows player');
	requireStep(summary, 'E3 launch Viewport Service for probe');
	requireStep(summary, 'E3 probe Viewport Service scene/game/input');
	requireStep(summary, 'E3 measure Viewport Service 1280x720@30');

	const preflightPath = resolveWindowsArtifact(proof, 'preflight', 'windows-proof-preflight.json');
	const preflight = readJson(preflightPath);
	if (preflight.platform !== 'win32' || preflight.windowsHost !== true) {
		throw new Error(`Windows preflight artifact was not produced on a Windows host: ${preflight.platform}`);
	}
	if ((preflight.counts?.fail || 0) > 0) {
		throw new Error(`Windows preflight artifact contains failed checks: ${preflight.counts.fail}`);
	}

	const e1Path = resolveWindowsArtifact(proof, 'e1DllMountProbe', 'e1-dll-mount-probe-windows.json');
	const e1 = readJson(e1Path);
	requireIncludes(String(e1.verdict || ''), 'DLL mounting is NOT a viable editor-rendering lane');
	requireArray(e1.probes, 'Windows E1 probes');

	const e2ResultPath = resolveWindowsArtifact(proof, 'e2HiddenEditorSpikeResult', 'e2-hidden-editor-spike-result-windows.json');
	const e2 = readJson(e2ResultPath);
	if (e2.success !== true || e2.allCapturesSucceeded !== true) {
		throw new Error('Windows E2 hidden editor spike did not record full capture success');
	}
	requireArray(e2.captures, 'Windows E2 captures');
	if (e2.captures.length < 5) {
		throw new Error(`expected at least 5 Windows editor-window captures; found ${e2.captures.length}`);
	}
	if (e2.inputTest?.changed !== true) {
		throw new Error('Windows E2 SceneView input test did not record a rotation change');
	}

	const e2MeasurePath = resolveWindowsArtifact(proof, 'e2HiddenEditorSpikeMeasure', 'e2-hidden-editor-spike-measure-windows.json');
	readJson(e2MeasurePath);

	const cursorSmokePath = resolveWindowsArtifact(proof, 'installedCursorViewportSmoke', 'installed-cursor-editor-scene-game-auto-smoke-windows.json');
	const cursorSmoke = readJson(cursorSmokePath);
	if (cursorSmoke.platform !== 'win32') {
		throw new Error(`Windows installed-Cursor smoke platform mismatch: ${cursorSmoke.platform}`);
	}
	if (cursorSmoke.status !== 'pass') {
		throw new Error(`Windows installed-Cursor smoke did not pass: ${cursorSmoke.status}`);
	}
	if (cursorSmoke.viewportProof?.result?.status !== 'pass') {
		throw new Error('Windows installed-Cursor smoke report does not embed a passing viewport proof');
	}
	const cursorProofPath = resolveWindowsArtifact(proof, 'installedCursorViewportProof', 'installed-cursor-editor-scene-game-auto-proof-windows.json');
	const cursorProof = readJson(cursorProofPath);
	if (cursorProof.status !== 'pass' || cursorProof.proofMode !== 'installed-cursor-editor-scene-game') {
		throw new Error(`Windows installed-Cursor viewport proof did not pass: ${cursorProof.status}`);
	}
	if (cursorProof.extension?.id !== 'rankupgames.unity-cursor-toolkit') {
		throw new Error('Windows installed-Cursor proof did not run inside the packaged toolkit extension');
	}
	if (cursorProof.connection?.state !== 'connected' || cursorProof.connection?.port !== 55500) {
		throw new Error('Windows installed-Cursor proof was not connected to the official Unity editor bridge on 55500');
	}
	validateInstalledCursorProofPanel(cursorProof.panels?.sceneView, 'scene');
	validateInstalledCursorProofPanel(cursorProof.panels?.gameView, 'game');

	const e3ProbePath = resolveWindowsArtifact(proof, 'e3ViewportServiceProbeTranscript', 'e3-viewport-service-probe-windows.txt');
	readText(e3ProbePath);

	const e3MeasurePath = resolveWindowsArtifact(proof, 'e3ViewportServiceMeasurement', 'e3-viewport-service-game-1280x720-30fps-windows.json');
	const e3 = readJson(e3MeasurePath);
	if (e3.platform !== 'win32') {
		throw new Error(`Windows E3 measurement platform mismatch: ${e3.platform}`);
	}
	if (e3.request?.host !== 'player' || e3.request?.captureMode !== 'camera') {
		throw new Error('Windows E3 player perf result is not a player camera stream');
	}
	if (e3.request?.width !== 1280 || e3.request?.height !== 720 || e3.request?.fps !== 30) {
		throw new Error('Windows E3 player perf result is not 1280x720@30');
	}
	if (!Number.isFinite(e3.summary?.effectiveFps) || e3.summary.effectiveFps < 25) {
		throw new Error(`Windows E3 effective fps below audit threshold: ${e3.summary?.effectiveFps}`);
	}
	if (Array.isArray(e3.errors) === false || e3.errors.length !== 0) {
		throw new Error('Windows E3 player perf result recorded errors');
	}
	return {
		evidence: [
			proof.relativePath,
			preflightPath,
			e1Path,
			e2ResultPath,
			e2MeasurePath,
			cursorSmokePath,
			cursorProofPath,
			e3ProbePath,
			e3MeasurePath
		],
		metrics: {
			sceneFrameWidth: cursorProof.panels.sceneView.frame.width,
			sceneFrameHeight: cursorProof.panels.sceneView.frame.height,
			gameFrameWidth: cursorProof.panels.gameView.frame.width,
			gameFrameHeight: cursorProof.panels.gameView.frame.height,
			effectiveFps: e3.summary.effectiveFps,
			startupMs: e3.summary.startupMs,
			timeToFirstFrameMs: e3.summary.timeToFirstFrameMs
		}
	};
}

function requireStep(summary, label) {
	const steps = Array.isArray(summary.steps) ? summary.steps : [];
	const step = steps.find((candidate) => candidate.label === label || candidate.id === slugify(label));
	if (!step) {
		throw new Error(`Windows proof summary is missing step: ${label}`);
	}
	if (step.status !== 'pass') {
		throw new Error(`Windows proof step did not pass: ${label} (${step.status})`);
	}
}

function resolveWindowsArtifact(proof, key, fallbackFileName) {
	const descriptor = proof.summary.artifacts?.[key];
	const candidates = [];
	if (descriptor?.relativePath) {
		candidates.push(descriptor.relativePath);
	}
	if (typeof descriptor === 'string') {
		candidates.push(descriptor);
	}
	if (descriptor?.path) {
		candidates.push(descriptor.path);
	}
	candidates.push(path.join(path.dirname(proof.relativePath), fallbackFileName));
	for (const candidate of candidates) {
		const relativePath = normalizeArtifactCandidate(candidate);
		if (relativePath && fs.existsSync(resolveRepoPath(relativePath))) {
			return relativePath;
		}
	}
	throw new Error(`Windows proof artifact is missing: ${key}`);
}

function normalizeArtifactCandidate(candidate) {
	if (!candidate) {
		return null;
	}
	const text = String(candidate).replace(/\\/g, '/');
	const normalizedRepo = repoRoot.replace(/\\/g, '/');
	if (text.startsWith(normalizedRepo + '/')) {
		return text.slice(normalizedRepo.length + 1);
	}
	if (path.isAbsolute(text) || /^[A-Za-z]:\//.test(text)) {
		return null;
	}
	return text.replace(/^\.\//, '');
}

function summaryTimestamp(proof) {
	return Date.parse(proof.summary?.completedAt || proof.summary?.generatedAt || '') || 0;
}

function walkFiles(root, visit) {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolutePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			walkFiles(absolutePath, visit);
		} else if (entry.isFile()) {
			visit(absolutePath);
		}
	}
}

function toRepoRelative(absolutePath) {
	return path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

function slugify(value) {
	return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function runCheck(check) {
	try {
		return check();
	} catch (error) {
		return fail(check.name.replace(/^check/, '').replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^-/, ''), error.message || String(error));
	}
}

function pass(id, summary, evidence, metrics) {
	return {
		id,
		status: 'pass',
		summary,
		evidence: evidence.map(normalizePath),
		...(metrics ? { metrics } : {})
	};
}

function pending(id, summary, evidence) {
	return {
		id,
		status: 'pending',
		summary,
		evidence: evidence.map(normalizePath)
	};
}

function fail(id, summary) {
	return {
		id,
		status: 'fail',
		summary,
		evidence: []
	};
}

function printHumanReport(value) {
	console.log('Unity Cursor Toolkit -- Unity Without Editor Fulfillment Audit\n');
	for (const check of value.checks) {
		const label = check.status.toUpperCase().padEnd(7);
		console.log(`${label} ${check.id}: ${check.summary}`);
	}
	console.log('');
	console.log(`Status: ${value.status.toUpperCase()} (${value.counts.pass} pass, ${value.counts.pending} pending, ${value.counts.fail} fail)`);
	if (value.counts.pending > 0 && strict === false) {
		console.log('Run with --strict to fail pending gates such as the required Windows proof.');
	}
	if (outPath) {
		console.log(`Wrote ${path.resolve(outPath)}`);
	}
}

function requireIncludes(text, needle) {
	if (!text.includes(needle)) {
		throw new Error(`missing expected text: ${needle}`);
	}
}

function requireArray(value, name) {
	if (Array.isArray(value) === false || value.length === 0) {
		throw new Error(`${name} is missing or empty`);
	}
}

function expectedViewportCommands() {
	return [
		'unity-cursor-toolkit.viewport.openSceneView',
		'unity-cursor-toolkit.viewport.openGameView',
		'unity-cursor-toolkit.viewport.openPlayerSceneView',
		'unity-cursor-toolkit.viewport.openPlayerGameView',
		'unity-cursor-toolkit.viewport.openInspector',
		'unity-cursor-toolkit.viewport.openPackageManager',
		'unity-cursor-toolkit.viewport.openCustomWindow'
	];
}

function readText(relativePath) {
	const absolutePath = resolveRepoPath(relativePath);
	if (!fs.existsSync(absolutePath)) {
		throw new Error(`missing file: ${relativePath}`);
	}
	return fs.readFileSync(absolutePath, 'utf8');
}

function readJson(relativePath) {
	try {
		return JSON.parse(readText(relativePath));
	} catch (error) {
		throw new Error(`invalid JSON in ${relativePath}: ${error.message || String(error)}`);
	}
}

function writeJson(absolutePath, value) {
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, JSON.stringify(value, null, 2) + '\n');
}

function resolveRepoPath(relativePath) {
	if (path.isAbsolute(relativePath)) {
		return relativePath;
	}
	return path.join(repoRoot, ...String(relativePath).split(/[\\/]+/));
}

function normalizePath(relativePath) {
	return String(relativePath).replace(/\\/g, '/');
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}
