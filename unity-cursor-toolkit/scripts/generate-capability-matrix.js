/** Generate runtime capability documentation and CI data from project_info. */
const fs = require('fs');
const path = require('path');

function advertisedCapabilities(source) {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex(line => line.includes('\\"runtime\\":{'));
	if (start < 0) throw new Error('project_info runtime payload is missing');
	const names = [];
	let closed = false;
	for (const line of lines.slice(start + 1)) {
		const match = line.match(/\\"(\w+)\\"/);
		if (match) names.push(match[1]);
		if (line.includes('Append("},")')) { closed = true; break; }
	}
	if (!closed || !names.length || new Set(names).size !== names.length) throw new Error('project_info runtime payload is invalid');
	return names.sort();
}

function generateMatrix(capabilities, input) {
	const names = [...new Set(capabilities)].sort();
	if (!names.length || !input.bands.length || new Set(input.bands).size !== input.bands.length) throw new Error('Capability matrix input is invalid');
	const rows = names.map(capability => ({
		capability,
		cells: Object.fromEntries(input.bands.map(band => {
			const records = input.observations.filter(record => record.capability === capability && record.band === band);
			if (records.length > 1) throw new Error('Duplicate capability observation: ' + capability + ' / ' + band);
			const record = records[0];
			if (record && (!['verified', 'expected', 'unsupported', 'untested'].includes(record.state) || !record.evidence)) {
				throw new Error('Capability observations require a valid state and evidence');
			}
			return [band, record ? { state: record.state, evidence: record.evidence } : { state: 'untested' }];
		}))
	}));
	const include = input.ci.include.map(entry => {
		if (!input.bands.includes(entry.band) || typeof entry.editorVersion !== 'string' || !/^\d+\.\d+\.\d+[abfp]\d+$/.test(entry.editorVersion) || typeof entry.id !== 'string' || !entry.id || typeof entry.platform !== 'string' || !entry.platform) throw new Error('CI candidate is invalid');
		return entry;
	}).sort((a, b) => a.id.localeCompare(b.id));
	if (new Set(include.map(entry => entry.id)).size !== include.length) throw new Error('Duplicate compatibility candidate');
	return { schemaVersion: 1, bands: input.bands, rows, ci: { include } };
}

/** A passing local smoke is evidence for this exact candidate, never an entire band. */
function validateCompatibilityReport(report, matrix) {
	const candidate = report && matrix.ci.include.find(entry => entry.id === report.candidateId);
	if (!candidate || report.band !== candidate.band || report.editorVersion !== candidate.editorVersion || report.requestedEditorVersion !== candidate.editorVersion || report.observedEditorVersion !== candidate.editorVersion || report.platform !== candidate.platform ||
		!['x64', 'arm64'].includes(report.architecture) || !Number.isInteger(report.pid) || report.pid <= 0 ||
		typeof report.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.observedAt) || !Number.isFinite(Date.parse(report.observedAt))) throw new Error('Compatibility candidate identity is invalid');
	if (report.passed !== true || report.outcome !== 'passed' || report.identityConfirmed !== true || report.normalExitConfirmed !== true || report.launched !== true || report.listenerOwnerConfirmed !== true || report.ownedPreferencesAbsent !== true || report.ownedPreferenceQueryConfirmed !== true || Object.prototype.hasOwnProperty.call(report, 'cleanupError') ||
		['forcedMcpStop', 'forcedEditorStop'].some(key => key in report && report[key] !== false) || Object.prototype.hasOwnProperty.call(report, 'error') || !Array.isArray(report.remainingOwnedPids) || report.remainingOwnedPids.length ||
		!report.editorExit || report.editorExit.code !== 0 || report.editorExit.signal !== null || report.editorExit.spawnError !== false ||
		!report.mcpExit || report.mcpExit.code !== 0 || report.mcpExit.signal !== null || report.mcpExit.spawnError !== false) throw new Error('Compatibility run did not complete successfully');
	const checks = ['activation', 'handshake', 'console', 'mcp'];
	if (!Array.isArray(report.checks) || report.checks.length !== checks.length ||
		!checks.every(name => report.checks.filter(check => check && check.name === name && check.status === 'pass').length === 1)) throw new Error('All compatibility checks must pass');
	const runtime = report.runtime, activation = report.activation;
	if (!runtime || typeof runtime.isCoreCLR !== 'boolean' || typeof runtime.hasDomainReload !== 'boolean' || runtime.isCoreCLR === runtime.hasDomainReload ||
		!activation || activation.assembly !== 'UnityCursorToolkit.Editor' || typeof activation.assemblyMvid !== 'string' ||
		!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(activation.assemblyMvid) || !Number.isInteger(activation.handlerCount) || activation.handlerCount < 1 ||
		typeof activation.automaticListenerObserved !== 'boolean' || !activation.runtime ||
		activation.runtime.isCoreCLR !== runtime.isCoreCLR || activation.runtime.hasDomainReload !== runtime.hasDomainReload) throw new Error('Observed runtime identity is invalid');
	if (!report.isolation || report.isolation.disposableProject !== true || report.isolation.defaultInstallActivationProven !== false ||
		!report.isolation.handlerSource || typeof report.isolation.handlerSource.originalSha256 !== 'string' || typeof report.isolation.handlerSource.fixtureSha256 !== 'string' || report.isolation.handlerSource.originalSha256 === report.isolation.handlerSource.fixtureSha256 || !/^[0-9a-f]{64}$/.test(report.isolation.handlerSource.originalSha256) ||
		!/^[0-9a-f]{64}$/.test(report.isolation.handlerSource.fixtureSha256) ||
		report.isolation.handlerSource.delta !== 'two preference key literals only') throw new Error('Compatibility fixture isolation is invalid');
	return candidate;
}

function importCompatibilityResults(input, reports) {
	const next = JSON.parse(JSON.stringify(input));
	const matrix = generateMatrix(['isCoreCLR', 'hasDomainReload'], input);
	for (const report of reports) {
		const candidate = validateCompatibilityReport(report, matrix);
		for (const capability of ['isCoreCLR', 'hasDomainReload']) {
			const evidence = report.observedAt + ': Unity ' + candidate.editorVersion + ', ' + candidate.platform + ' ' + report.architecture +
				'. Isolated local activation, handshake, console and stdio MCP checks passed; ' + capability + '=' + report.runtime[capability] +
				'. Two fixture-only preference keys and an OS-selected port; default-install activation and other versions/platforms remain untested.';
			const existing = next.observations.find(record => record.capability === capability && record.band === candidate.band);
			if (existing) {
				existing.state = 'verified';
				existing.evidence = [...new Set([...(existing.evidence ? existing.evidence.split('\n') : []), evidence])].sort().join('\n');
			} else next.observations.push({ capability, band: candidate.band, state: 'verified', evidence });
		}
	}
	next.observations.sort((a, b) => a.capability.localeCompare(b.capability) || a.band.localeCompare(b.band));
	return next;
}

function renderMarkdown(matrix) {
	const lines = [
		'# Runtime capability matrix', '',
		'Generated by `node unity-cursor-toolkit/scripts/generate-capability-matrix.js`.', '',
		'Rows come from the runtime fields advertised by `project_info`.',
		'Untested cells are not support claims. CI candidates are configured checks, not recorded successful runs.',
		'A band cell describes its recorded evidence only. It does not certify every Editor or platform in that band.', '',
		'| Capability | ' + matrix.bands.join(' | ') + ' |',
		'| --- | ' + matrix.bands.map(() => '---').join(' | ') + ' |',
		...matrix.rows.map(row => '| ' + row.capability + ' | ' + matrix.bands.map(band => row.cells[band].state).join(' | ') + ' |'), '',
		'States: `verified` requires recorded proof. `expected` records an evidence-backed expectation.',
		'`unsupported` records a known refusal. `untested` means no recorded capability evidence.', '',
		'Input: `unity-cursor-toolkit/capability-matrix-input.json`. Machine output: `unity-cursor-toolkit/capability-matrix.json`.', '',
		'## Runtime interpretation', '',
		'`isCoreCLR` reports the running Editor runtime. It does not report the Player scripting backend.',
		'`hasDomainReload` reports runtime support for AppDomain reload, not the Enter Play Mode project option.',
		'CoreCLR disables toolkit IL patch requests and the existing Mono debug adapter. Unity still compiles and reloads scripts.',
		'This does not claim instant hot reload or a working CoreCLR debugger.', '',
		'The original issue assumed CoreCLR in Unity 6000.8. The version define remains a version marker only.',
		"Unity's [October 2026 update](https://discussions.unity.com/t/coreclr-scripting-and-net-update-october-2026/1738338) identifies Unity 7.0 alpha as the first CoreCLR Editor.",
		'The initial alpha targets C# 9 and .NET Standard 2.1. It uses AssemblyLoadContext reload and does not include instant live code iteration.', '',
		'## Recorded evidence', ''
	];
	for (const row of matrix.rows) for (const band of matrix.bands) {
		if (row.cells[band].evidence) lines.push('- ' + row.capability + ' / ' + band + ': ' + row.cells[band].evidence.replace(/\n/g, ' '));
	}
	if (!matrix.rows.some(row => matrix.bands.some(band => row.cells[band].evidence))) lines.push('No runtime capability runs are recorded.');
	return lines.join('\n') + '\n';
}

function main() {
	const root = path.resolve(__dirname, '..', '..');
	const source = fs.readFileSync(path.join(root, 'Packages/com.rankupgames.unity-cursor-toolkit/Editor/MCP/ProjectInfoProvider.cs'), 'utf8');
	let input = JSON.parse(fs.readFileSync(path.join(root, 'unity-cursor-toolkit/capability-matrix-input.json'), 'utf8'));
	const importIndex = process.argv.indexOf('--import-results');
	if (importIndex >= 0) {
		if (process.argv.includes('--check') || !process.argv[importIndex + 1]) throw new Error('--import-results requires a report and cannot be combined with --check');
		input = importCompatibilityResults(input, [JSON.parse(fs.readFileSync(process.argv[importIndex + 1], 'utf8'))]);
		fs.writeFileSync(path.join(root, 'unity-cursor-toolkit/capability-matrix-input.json'), JSON.stringify(input, null, 2) + '\n');
	}
	const matrix = generateMatrix(advertisedCapabilities(source), input);
	const outputs = [
		['unity-cursor-toolkit/capability-matrix.json', JSON.stringify(matrix, null, 2) + '\n'],
		['docs/CAPABILITY_MATRIX.md', renderMarkdown(matrix)]
	];
	for (const [file, content] of outputs) {
		const target = path.join(root, file);
		if (process.argv.includes('--check')) {
			if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== content) throw new Error(file + ' is stale. Regenerate the capability matrix.');
		} else fs.writeFileSync(target, content);
	}
}

module.exports = { advertisedCapabilities, generateMatrix, renderMarkdown, validateCompatibilityReport };
if (require.main === module) main();
