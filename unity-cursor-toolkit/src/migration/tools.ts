import * as path from 'path';
import type { ICommandSender, ToolResult } from '../core/interfaces';
import { scan } from './index';
import { formatReport } from './report';
import { MigrationError, migrationRules } from './rules';

export async function handleMigrationTool(
	args: Record<string, unknown>, projectRoot: string | undefined, sender: ICommandSender
): Promise<ToolResult> {
	try {
		if (typeof args.action !== 'string' || !['scan', 'report', 'rules'].includes(args.action)) {
			throw new MigrationError('INVALID_ACTION', 'action must be scan, report, or rules.');
		}
		if (args.action === 'rules') return textResult(JSON.stringify(migrationRules));
		const result = await scan(projectRoot ?? '');
		let staticsInventory: unknown;
		if (args.includeStatics === true) {
			let response;
			try {
				response = await sender.request('mcpToolCall', { toolName: 'coreclr_migration', args: { action: 'scan' } });
			} catch (error) {
				throw new MigrationError('INVENTORY_UNAVAILABLE', `Loaded static inventory request failed: ${error instanceof Error ? error.message : String(error)}. Connect the matching Unity project and retry.`);
			}
			const payload = response?.result;
			if (response?.error === true || payload == null || typeof payload !== 'object'
				|| !('staticsInventory' in payload) || (payload as { success?: unknown }).success === false) {
				throw new MigrationError('INVENTORY_UNAVAILABLE', 'Loaded static inventory is unavailable. Connect the matching Unity project with the current toolkit package.');
			}
			const inventoryProject = (payload as { projectPath?: unknown }).projectPath;
			const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
			if (typeof inventoryProject !== 'string' || normalize(inventoryProject) !== normalize(projectRoot!)) {
				throw new MigrationError('INVENTORY_UNAVAILABLE', 'The connected Unity project does not match the source scan project.');
			}
			staticsInventory = (payload as { staticsInventory: unknown }).staticsInventory;
			if (staticsInventory == null || typeof staticsInventory !== 'object'
				|| !Array.isArray((staticsInventory as { fields?: unknown }).fields)) {
				throw new MigrationError('INVENTORY_UNAVAILABLE', 'Unity returned invalid static inventory metadata.');
			}
		}
		return textResult(args.action === 'report' ? formatReport(result, staticsInventory)
			: JSON.stringify({ ...result, ...(staticsInventory === undefined ? {} : { staticsInventory }) }));
	} catch (error) {
		return migrationToolError(error);
	}
}

function migrationToolError(error: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify({
		errorCode: error instanceof MigrationError ? error.code : 'SCAN_FAILED',
		error: error instanceof Error ? error.message : String(error)
	}) }], isError: true };
}

function textResult(text: string): ToolResult {
	return { content: [{ type: 'text', text }] };
}
