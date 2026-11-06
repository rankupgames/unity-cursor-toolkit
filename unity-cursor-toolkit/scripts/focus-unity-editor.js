#!/usr/bin/env node
'use strict';

// Focuses the one running Unity Editor that owns --project. Runs from source (Node 22.18+ type stripping), no build needed.
// Usage: node scripts/focus-unity-editor.js --project <unity-project-root> [--expected-pid <pid>]
// Exit codes: 0 activated, 1 any other state, 2 bad usage. Activation alone does not prove compilation or main-thread recovery.

const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
	const args = process.argv.slice(2);
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index], value = args[index + 1];
		if (!['--project', '--expected-pid'].includes(name) || values.has(name) || !value || value.startsWith('--')) {
			console.error('Usage: node scripts/focus-unity-editor.js --project <unity-project-root> [--expected-pid <pid>]');
			return 2;
		}
		values.set(name, value);
	}
	const project = values.get('--project');
	const pidText = values.get('--expected-pid');
	const expectedPid = pidText === undefined ? undefined : Number(pidText);
	if (!project || (pidText !== undefined && (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(expectedPid) || expectedPid > 2147483647))) {
		console.error('Usage: node scripts/focus-unity-editor.js --project <unity-project-root> [--expected-pid <pid>]');
		return 2;
	}
	const { focusUnityEditor } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'core', 'unityEditorFocus.ts')).href);
	const result = await focusUnityEditor({ projectRoot: project, expectedPid });
	console.log(JSON.stringify(result));
	return result.state === 'activated' ? 0 : 1;
}

main().then(code => { process.exitCode = code; }, error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
