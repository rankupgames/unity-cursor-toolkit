import { MigrationScanResult } from './index';
import { migrationRules, MigrationSeverity } from './rules';

export const migrationReportFileName = 'CoreCLR-Migration-Report.md';

export function formatReport(result: MigrationScanResult, staticsInventory?: unknown): string {
	const severities: MigrationSeverity[] = ['breaks', 'behavior-change', 'deprecated'];
	const counts = severities.map(severity => `${severity}: ${result.findings.filter(finding => finding.severity === severity).length}`).join(', ');
	const lines = [
		'# CoreCLR Migration Report', '',
		`Scan date: ${result.scannedAt}`,
		`Rule set: ${result.ruleSetVersion} (source date: ${migrationRules.sourceDate})`,
		`Files scanned: ${result.scanned}; files skipped: ${result.skipped}`,
		`Findings: ${counts}`, '',
		migrationRules.limitations, ''
	];
	if (result.findings.length === 0) lines.push('No findings.', '');
	for (const severity of severities) {
		const findings = result.findings.filter(finding => finding.severity === severity);
		if (findings.length === 0) continue;
		lines.push(`## ${severity}`, '');
		for (const finding of findings) {
			const rule = migrationRules.rules.find(candidate => candidate.id === finding.ruleId)!;
			lines.push(
				`### ${escapeMarkdown(finding.file)}:${finding.line} (${rule.id})`, '',
				`    ${finding.snippet}`, '', rule.explanation, '',
				`Replacement: ${rule.replacement}`, '',
				`[Unity documentation](${rule.docsUrl})`, ''
			);
		}
	}
	if (staticsInventory !== undefined) {
		lines.push('## Loaded user static fields', '', 'Metadata only; no field values are read or changed.', '',
			'    ' + JSON.stringify(staticsInventory), '');
	}
	return lines.join('\n');
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_[\]<>]/g, character => '\\' + character);
}
