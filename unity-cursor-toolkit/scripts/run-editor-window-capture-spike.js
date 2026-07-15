#!/usr/bin/env node
/**
 * Launches the bundled CursorUnityTool project in a FULL editor session (no
 * -batchmode) and runs UCTEditorWindowCaptureSpike, which proves that real
 * EditorWindows (Scene View, Game View, Inspector, Package Manager, custom)
 * can be captured via GUIView.GrabPixels and driven via EditorWindow.SendEvent.
 *
 * Usage:
 *   node scripts/run-editor-window-capture-spike.js [--hide] [--keep-open]
 *        [--timeout 300] [--force] [--measure] [--measure-out path]
 *
 * Close Unity first -- the runner refuses to start while the project lock is
 * held (use --force to override after a crash left a stale lock).
 *
 * See docs/EDITOR_WINDOW_STREAMING_PLAN.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const projectRoot = path.join(repoRoot, 'CursorUnityTool');
const tempRoot = os.tmpdir();
const resultPath = path.join(tempRoot, 'uct-editor-window-spike-result.json');
const outputDir = path.join(tempRoot, 'uct-editor-window-spike');
const unityLogPath = path.join(tempRoot, 'uct-editor-window-spike.log');
const measurePath = getStringArg('--measure-out', path.join(tempRoot, 'uct-editor-window-spike-measure.json'));

const options = {
	hide: hasFlag('--hide'),
	keepOpen: hasFlag('--keep-open'),
	force: hasFlag('--force'),
	measure: hasFlag('--measure'),
	timeoutSeconds: getIntArg('--timeout', 300)
};

let unityProcess = null;
let finished = false;
let hideAttempt = 0;
let measureTimer = null;
let measurement = null;

function main() {
	const lockPath = path.join(projectRoot, 'Temp', 'UnityLockfile');
	if (fs.existsSync(lockPath) && options.force === false) {
		console.error('Project lock is held: ' + lockPath);
		console.error('Close Unity (CursorUnityTool) first, or pass --force if the lock is stale.');
		process.exit(1);
	}

	fs.rmSync(resultPath, { force: true });
	fs.rmSync(unityLogPath, { force: true });
	fs.rmSync(outputDir, { recursive: true, force: true });
	fs.mkdirSync(outputDir, { recursive: true });

	const unityPath = resolveUnityPath();
	const args = [
		'-projectPath', projectRoot,
		'-executeMethod', 'UnityCursorToolkit.InternalSmoke.UCTEditorWindowCaptureSpike.Run',
		'-uctSpikeResultPath', resultPath,
		'-uctSpikeOutputDir', outputDir,
		'-uctSpikeAutoQuit', options.keepOpen ? 'false' : 'true',
		'-silent-crashes',
		'-logFile', unityLogPath
	];

	console.log('Unity Cursor Toolkit -- Editor Window Capture Spike\n');
	console.log(`Unity:   ${unityPath}`);
	console.log(`Project: ${projectRoot}`);
	console.log(`Result:  ${resultPath}`);
	console.log(`Frames:  ${outputDir}`);
	console.log('\nLaunching full editor session (this is NOT batchmode; first load can take a while)...\n');

	unityProcess = spawn(unityPath, args, { stdio: 'inherit' });
	unityProcess.on('error', (error) => fail('Unity failed to launch: ' + (error.message || String(error))));
	unityProcess.on('exit', (code) => {
		if (finished === false && fs.existsSync(resultPath) === false) {
			fail(`Unity exited (code ${code}) before writing a result.\n` + logTail());
		}
	});

	if (options.hide) {
		setTimeout(hideUnityApp, 5000);
		setTimeout(hideUnityApp, 15000);
	}

	const startedAt = Date.now();
	startMeasurement(unityPath, startedAt);
	const poll = setInterval(() => {
		if (fs.existsSync(resultPath)) {
			clearInterval(poll);
			markResultTime();
			// Give Unity a beat to flush/quit before reporting.
			setTimeout(() => report(), 750);
			return;
		}

		if ((Date.now() - startedAt) / 1000 > options.timeoutSeconds) {
			clearInterval(poll);
			fail(`Timed out after ${options.timeoutSeconds}s waiting for the spike result.\n` + logTail());
		}
	}, 1000);
}

function report() {
	if (finished) {
		return;
	}
	finished = true;

	let result;
	try {
		result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
	} catch (error) {
		fail('Result JSON unreadable: ' + (error.message || String(error)));
		return;
	}

	console.log('\n================ SPIKE RESULT ================');
	console.log(`Editor: ${result.editorVersion}  platform: ${result.platform || process.platform}  pixelsPerPoint: ${result.pixelsPerPoint}`);
	console.log('\nWindow captures (real EditorWindow pixels via GUIView.GrabPixels):');
	const captures = Array.isArray(result.captures) ? result.captures : [];
	for (const capture of captures) {
		if (capture.success) {
			console.log(`  PASS  ${pad(capture.window)} ${capture.width}x${capture.height}  distinctColors=${capture.distinctColors}  ${capture.path}`);
		} else {
			console.log(`  FAIL  ${pad(capture.window)} ${truncate(capture.error, 220)}`);
		}
	}

	const input = result.inputTest || {};
	console.log('\nSceneView input injection (EditorWindow.SendEvent, Alt+drag orbit):');
	if (input.attempted && input.changed) {
		console.log(`  PASS  rotation changed by ${input.rotationAngle} degrees`);
	} else {
		console.log(`  FAIL  attempted=${input.attempted} angle=${input.rotationAngle} error=${input.error || 'rotation did not change'}`);
	}

	const capturesPass = captures.length > 0 && captures.every((capture) => capture.success);
	const pass = result.success && capturesPass && input.changed === true;
	finishMeasurement(pass);
	console.log('\nVerdict: ' + (pass
		? 'GREEN -- GrabPixels + SendEvent are viable on this editor. Proceed with M1/M2 of the plan.'
		: 'NOT GREEN -- see failures above and the GUIView method dump in the result JSON; consult the fallback ladder in docs/EDITOR_WINDOW_STREAMING_PLAN.md section 7.'));
	if (options.measure) {
		console.log(`Measurement: ${measurePath}`);
	}
	console.log(`Open the captured frames: ${outputDir}`);
	if (options.keepOpen) {
		console.log('Unity was left running (--keep-open).');
	}
	console.log('==============================================\n');
	process.exitCode = pass ? 0 : 2;
}

function hideUnityApp() {
	hideAttempt++;
	if (process.platform === 'darwin') {
		const script = 'tell application "System Events" to set visible of (every process whose name contains "Unity") to false';
		const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
		child.on('error', () => {});
		if (hideAttempt === 1) {
			console.log('(Requested macOS to hide the Unity app -- best effort.)');
		}
		return;
	}

	if (process.platform === 'win32') {
		const script = [
			'$code = @"',
			'using System;',
			'using System.Runtime.InteropServices;',
			'public static class UCTShowWindow {',
			'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
			'}',
			'"@',
			'Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;',
			'Get-Process Unity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [UCTShowWindow]::ShowWindowAsync($_.MainWindowHandle, 0) | Out-Null }'
		].join('\n');
		const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
		child.on('error', () => {});
		if (hideAttempt === 1) {
			console.log('(Requested Windows to hide the Unity window -- best effort.)');
		}
		return;
	}

	if (hideAttempt === 1) {
		console.log(`(--hide is not implemented for ${process.platform}; continuing visible/background.)`);
	}
}

function fail(message) {
	if (finished) {
		return;
	}
	finished = true;
	finishMeasurement(false, message);
	console.error('\nSPIKE FAILED: ' + message);
	if (unityProcess && unityProcess.exitCode == null && options.keepOpen === false) {
		try { unityProcess.kill(); } catch (error) { /* ignore */ }
	}
	process.exitCode = 1;
}

function startMeasurement(unityPath, startedAt) {
	if (options.measure === false || unityProcess == null || unityProcess.pid == null) {
		return;
	}

	measurement = {
		schemaVersion: 1,
		platform: process.platform,
		pid: unityProcess.pid,
		unityPath,
		projectRoot,
		resultPath,
		outputDir,
		startedAt: new Date(startedAt).toISOString(),
		timeoutSeconds: options.timeoutSeconds,
		samples: []
	};
	writeMeasurement();
	sampleUnityMetrics();
	measureTimer = setInterval(sampleUnityMetrics, 5000);
}

function markResultTime() {
	if (measurement == null || measurement.resultAt) {
		return;
	}

	const now = Date.now();
	measurement.resultAt = new Date(now).toISOString();
	measurement.timeToResultSeconds = Number(((now - Date.parse(measurement.startedAt)) / 1000).toFixed(3));
	writeMeasurement();
}

function finishMeasurement(success, error) {
	if (measureTimer != null) {
		clearInterval(measureTimer);
		measureTimer = null;
	}

	if (measurement == null) {
		return;
	}

	if (measurement.resultAt == null && fs.existsSync(resultPath)) {
		markResultTime();
	}
	measurement.finishedAt = new Date().toISOString();
	measurement.success = success === true;
	if (error) {
		measurement.error = String(error);
	}
	writeMeasurement();
}

function sampleUnityMetrics() {
	if (measurement == null || unityProcess == null || unityProcess.pid == null) {
		return;
	}

	const pid = String(unityProcess.pid);
	if (process.platform === 'win32') {
		const script = [
			'$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue;',
			'if ($p) { [pscustomobject]@{ rssMb = [math]::Round($p.WorkingSet64 / 1MB, 1); cpuSeconds = [math]::Round($p.CPU, 3) } | ConvertTo-Json -Compress }'
		].join(' ');
		execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], (error, stdout) => {
			if (error || !stdout.trim()) {
				recordMetricSample({ error: error ? error.message : 'Unity process not found' });
				return;
			}

			try {
				recordMetricSample(JSON.parse(stdout));
			} catch (parseError) {
				recordMetricSample({ error: parseError.message || String(parseError) });
			}
		});
		return;
	}

	execFile('ps', ['-o', 'rss=,pcpu=', '-p', pid], (error, stdout) => {
		if (error || !stdout.trim()) {
			recordMetricSample({ error: error ? error.message : 'Unity process not found' });
			return;
		}

		const parts = stdout.trim().split(/\s+/);
		recordMetricSample({
			rssMb: Number((Number(parts[0]) / 1024).toFixed(1)),
			cpuPercent: Number(Number(parts[1]).toFixed(1))
		});
	});
}

function recordMetricSample(sample) {
	if (measurement == null) {
		return;
	}

	measurement.samples.push(Object.assign({
		at: new Date().toISOString(),
		elapsedSeconds: Number(((Date.now() - Date.parse(measurement.startedAt)) / 1000).toFixed(3))
	}, sample));
	writeMeasurement();
}

function writeMeasurement() {
	if (measurement == null) {
		return;
	}

	try {
		fs.writeFileSync(measurePath, JSON.stringify(measurement, null, 2));
	} catch (error) {
		// Measurement must never fail the functional spike.
	}
}

function logTail(lines = 40) {
	try {
		return '--- Unity log tail ---\n' + fs.readFileSync(unityLogPath, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
	} catch (error) {
		return '(no Unity log available)';
	}
}

function resolveUnityPath() {
	if (process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH && fs.existsSync(process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH)) {
		return process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH;
	}

	const versionText = fs.readFileSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
	const versionMatch = /^m_EditorVersion:\s*(.+)$/m.exec(versionText);
	const version = versionMatch && versionMatch[1].trim();
	const candidates = process.platform === 'darwin'
		? [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`]
		: process.platform === 'win32'
			? [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`]
			: [`/opt/Unity/Hub/Editor/${version}/Editor/Unity`];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error('Unity executable not found. Set UNITY_CURSOR_TOOLKIT_UNITY_PATH.');
}

function hasFlag(name) {
	return process.argv.includes(name);
}

function getIntArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		const value = Number.parseInt(process.argv[index + 1], 10);
		if (Number.isFinite(value)) {
			return value;
		}
	}
	return fallback;
}

function getStringArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return fallback;
}

function pad(value) {
	return String(value || '').padEnd(16, ' ');
}

function truncate(value, max) {
	const text = String(value || '');
	return text.length > max ? text.slice(0, max) + '...' : text;
}

main();
