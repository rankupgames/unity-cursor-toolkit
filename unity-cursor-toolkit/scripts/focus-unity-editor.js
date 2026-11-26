#!/usr/bin/env node
/** Foreground the verified existing project owner; never open a second Unity Editor. */
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
 const args = process.argv.slice(2);
 const allowed = new Set(['--project', '--expected-pid']);
 const values = {};
 for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || values[args[i]] != null || !args[i + 1]) throw new Error('Usage: --project <root> [--expected-pid <pid>]');
  values[args[i]] = args[i + 1];
 }
 if (!values['--project'] || (values['--expected-pid'] && !/^[1-9]\d*$/.test(values['--expected-pid']))) throw new Error('A project root and valid optional PID are required.');
 const { focusUnityEditor } = await import(pathToFileURL(path.join(__dirname, '../src/core/unityEditorFocus.ts')).href);
 const result = await focusUnityEditor(path.resolve(values['--project']), { expectedPid: values['--expected-pid'] ? Number(values['--expected-pid']) : undefined });
 process.stdout.write(JSON.stringify(result) + '\n');
 process.exitCode = result.state === 'activated' ? 0 : 1;
})().catch(error => { process.stdout.write(JSON.stringify({ state: 'failed', reason: error.message }) + '\n'); process.exitCode = 2; });
