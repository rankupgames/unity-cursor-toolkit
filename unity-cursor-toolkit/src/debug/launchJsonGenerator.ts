/**
 * Generates or merges .vscode/launch.json with Unity debug configurations.
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */

import * as path from 'path';
import * as fs from 'fs';

const DEBUG_TYPE = 'unityCursorToolkit.debug';

const UNITY_EDITOR_CONFIG = {
	name: 'Attach to Unity Editor',
	type: DEBUG_TYPE,
	request: 'attach',
	debugPort: 56000
};

const UNITY_PLAYER_CONFIG = {
	name: 'Attach to Unity Player',
	type: DEBUG_TYPE,
	request: 'attach',
	debugPort: 56000,
	// Player typically uses the same port when built with Development build + Script Debugging
};

/**
 * Generates or merges launch.json in the project's .vscode folder.
 * Creates file with Unity configs if missing; merges Unity configs without overwriting existing ones.
 */
export async function generateLaunchJson(projectPath: string): Promise<void> {
	const vscodeDir = path.join(projectPath, '.vscode');
	const launchPath = path.join(vscodeDir, 'launch.json');

	let existing: { version: string; configurations: Record<string, unknown>[] } | undefined;

	if (fs.existsSync(launchPath)) {
		try {
			const raw = fs.readFileSync(launchPath, 'utf-8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && Array.isArray(parsed.configurations)) {
				existing = parsed;
			}
		} catch {
			existing = undefined;
		}
	}

	const unityConfigs = [UNITY_EDITOR_CONFIG, UNITY_PLAYER_CONFIG];
	const existingNames = new Set(
		(existing?.configurations ?? []).map((c: { name?: string }) => c.name).filter(Boolean)
	);

	const toAdd = unityConfigs.filter((c) => existingNames.has(c.name) === false);
	if (toAdd.length === 0 && existing != null) {
		return;
	}

	let configurations = [...(existing?.configurations ?? [])];
	for (const c of toAdd) {
		configurations.push(c);
	}

	const launch = {
		version: existing?.version ?? '0.2.0',
		configurations
	};

	await fs.promises.mkdir(vscodeDir, { recursive: true });
	await fs.promises.writeFile(launchPath, JSON.stringify(launch, null, 2), 'utf-8');
}
