/** Exact-project activation after verifying an existing Unity Editor process and bundle. */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export type FocusState = 'activated' | 'not_running' | 'ambiguous' | 'mismatch' | 'not_foreground' | 'failed' | 'unsupported';
export interface FocusResult { state: FocusState; pid?: number; reason: string; }
export type FocusCommand = (command: string, args: string[]) => Promise<string>;
export interface FocusOptions {
 platform?: string;
 expectedPid?: number;
 unityPath?: string;
 run?: FocusCommand;
 readVersion?: (file: string) => string;
}
const runCommand: FocusCommand = (command, args) => new Promise((resolve, reject) => {
 execFile(command, args, { timeout: 3000, maxBuffer: 32768, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function focusUnityEditor(projectRoot: string, options: FocusOptions = {}): Promise<FocusResult> {
 if ((options.platform ?? process.platform) !== 'darwin') return { state: 'unsupported', reason: 'Automatic activation is available only on macOS.' };
 const run = options.run ?? runCommand;
 const lock = path.join(path.resolve(projectRoot), 'Temp', 'UnityLockfile');
 let activating = false;
 const owners = async (): Promise<number[]> => {
  const result = await run('/usr/sbin/lsof', ['-t', lock]);
  const values = result.trim().split(/\s+/).filter(Boolean);
  if (values.some(value => !/^\d+$/.test(value))) return [];
  return [...new Set(values.map(Number))].filter(value => Number.isSafeInteger(value) && value > 0);
 };
 try {
  const pids = await owners();
  if (pids.length !== 1) return { state: pids.length ? 'ambiguous' : 'not_running', reason: 'The selected project must have exactly one Editor lock owner.' };
  const pid = pids[0];
  if (options.expectedPid != null && options.expectedPid !== pid) return { state: 'mismatch', pid, reason: 'The selected Editor process changed.' };
  const executable = (await run('/bin/ps', ['-p', String(pid), '-o', 'comm='])).trim();
  const configured = options.unityPath ?? process.env.UNITY_CURSOR_TOOLKIT_UNITY_PATH;
  const text = (options.readVersion ?? (file => fs.readFileSync(file, 'utf8')))(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'));
  const version = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(text)?.[1];
  const executableSuffix = '/Unity.app/Contents/MacOS/Unity';
  if (!version || !/^\d+\.\d+\.\d+[a-z]\d+$/i.test(version) || !executable.endsWith(executableSuffix) || (configured
   ? path.resolve(executable) !== path.resolve(configured)
   : !executable.endsWith('/' + version + '/Unity.app/Contents/MacOS/Unity'))) {
   return { state: 'mismatch', pid, reason: 'The lock owner executable does not match the selected project Editor.' };
  }
  const checked = await owners();
  if (checked.length !== 1 || checked[0] !== pid) return { state: 'mismatch', pid, reason: 'The project lock owner changed before activation.' };
  activating = true;
  // Target the existing owner by PID. Opening a bundle can choose a different running Editor.
  const processScript = `const pid=${pid}; const se=Application('System Events'); const matches=se.applicationProcesses.whose({unixId:pid})(); if(matches.length!==1 || matches[0].name()!=='Unity') throw Error('process_mismatch');`;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', processScript + ' matches[0].frontmost=true;']);
  // Use a fresh read-only process: an activation process can cache its own foreground result.
  const foreground = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', processScript + ' String(matches[0].frontmost());'])).trim();
  if (foreground !== 'true' && foreground !== 'false') return { state: 'failed', pid, reason: 'Foreground verification returned an invalid process state.' };
  const active = foreground === 'true';
  return { state: active ? 'activated' : 'not_foreground', pid, reason: active
   ? 'The verified project owner is foreground. This does not prove compile or main-thread recovery.'
   : 'macOS did not foreground the verified Editor process.' };
 } catch (error) {
  const code = (error as { code?: string | number }).code;
  return { state: code === 1 && !activating ? 'not_running' : 'failed', reason: error instanceof Error ? error.message : 'Editor activation failed.' };
 }
}
