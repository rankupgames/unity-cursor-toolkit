import * as fs from 'fs';
import * as path from 'path';

export type MigrationSeverity = 'breaks' | 'behavior-change' | 'deprecated';

export interface MigrationRule {
	id: string;
	pattern: string;
	severity: MigrationSeverity;
	explanation: string;
	replacement: string;
	docsUrl: string;
}

export interface MigrationRuleSet {
	schemaVersion: 1;
	version: string;
	sourceDate: string;
	sourceUrl: string;
	limitations: string;
	rules: MigrationRule[];
}

export class MigrationError extends Error {
	constructor(public readonly code: 'RULES_UNAVAILABLE' | 'RULES_INVALID' | 'PROJECT_UNREADABLE' | 'INVALID_ACTION' | 'INVENTORY_UNAVAILABLE', message: string) {
		super(message);
		this.name = 'MigrationError';
	}
}

export function loadRuleSet(filePath: string): MigrationRuleSet {
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf8');
	} catch {
		throw new MigrationError('RULES_UNAVAILABLE', `Migration rules cannot be read at ${filePath}. The scan cannot start. Restore the rule file.`);
	}

	try {
		const value = JSON.parse(content);
		if (!isRecord(value) || value.schemaVersion !== 1 || !hasStrings(value, ['version', 'sourceDate', 'sourceUrl', 'limitations'])
			|| !/^\d{4}-\d{2}-\d{2}$/.test(value.sourceDate) || !isHttpsUrl(value.sourceUrl)
			|| !Array.isArray(value.rules) || value.rules.length === 0) {
			throw new Error('Invalid rule set metadata');
		}

		const ids = new Set<string>();
		for (const rule of value.rules) {
			if (!isRecord(rule) || !hasStrings(rule, ['id', 'pattern', 'severity', 'explanation', 'replacement', 'docsUrl'])
				|| !['breaks', 'behavior-change', 'deprecated'].includes(rule.severity)
				|| ids.has(rule.id) || !isHttpsUrl(rule.docsUrl) || new RegExp(rule.pattern, 'gm').test('')) {
				throw new Error('Invalid or duplicate migration rule');
			}
			ids.add(rule.id);
		}
		return value as unknown as MigrationRuleSet;
	} catch {
		throw new MigrationError('RULES_INVALID', `Migration rules are malformed at ${filePath}. The scan cannot start. Restore a valid rule file.`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasStrings<K extends string>(value: Record<string, unknown>, keys: K[]): value is Record<string, unknown> & Record<K, string> {
	return keys.every(key => typeof value[key] === 'string' && (value[key] as string).trim().length > 0);
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

// Validate runtime data when the migration module loads. tsc copies the JSON to out/migration.
export const migrationRules = loadRuleSet(path.join(__dirname, 'coreclr-migration-rules.json'));
