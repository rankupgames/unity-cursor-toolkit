/** Bounded external recovery. The Node process survives Unity's main-thread stalls and reloads. */
import * as fs from 'fs';
import * as path from 'path';
import type { ICommandSender } from '../core/interfaces';
import type { FocusResult } from '../core/unityEditorFocus';

export interface RecoveryOptions {
 projectRoot?: string;
 focusEditor?: (root: string, pid?: number) => Promise<FocusResult>;
 now?: () => number;
 readValidation?: () => Record<string, unknown> | undefined;
 automatic?: boolean;
}
export interface RecoveryStatus {
 state: string;
 pending: boolean;
 success: boolean;
 compileSucceeded: boolean;
 focusAttempts: number;
 bridgeRecovered: boolean;
 requestId?: string;
 lastFocus?: FocusResult;
 reason?: string;
}

export class EditorRecoveryMonitor {
 private readonly sender: ICommandSender;
 private readonly options: RecoveryOptions;
 private readonly now: () => number;
 private statusValue: RecoveryStatus = { state: 'idle', pending: false, success: false, compileSucceeded: false, focusAttempts: 0, bridgeRecovered: false };
 private started = 0;
 private lastResponse = 0;
 private lastFocusAt = 0;
 private editorPid: number | undefined;
 private timer: ReturnType<typeof setTimeout> | undefined;
 private inFlight: Promise<RecoveryStatus> | undefined;
 private disposed = false;

 constructor(sender: ICommandSender, options: RecoveryOptions = {}) {
  this.sender = sender; this.options = options; this.now = options.now ?? Date.now;
 }
 public get status(): RecoveryStatus { return { ...this.statusValue }; }
 public recover(reason = 'explicit_recovery', requestId?: string): RecoveryStatus {
  if (this.disposed) return this.status;
  if (!this.options.projectRoot) return { ...this.status, state: 'project_required', reason: 'Select UNITY_CURSOR_TOOLKIT_PROJECT_PATH before recovery.' };
  if (!this.statusValue.pending) {
   this.started = this.now(); this.lastResponse = this.started; this.lastFocusAt = 0;
   this.statusValue = { state: 'waiting', pending: true, success: false, compileSucceeded: false, bridgeRecovered: false, focusAttempts: 0, requestId, reason };
  }
  this.schedule(); return this.status;
 }
 public observe(tool: string, payload: Record<string, unknown>): void {
  if (this.disposed) return;
  if (tool === 'project_info') {
   if (!this.matchesProject(payload.projectPath)) { this.finish('project_mismatch'); return; }
   if (typeof payload.editorPid === 'number') this.editorPid = payload.editorPid;
  }
  this.lastResponse = this.now();
  if (tool === 'editor_validation' && payload.pending === true) {
   this.recover('compile_pending', typeof payload.requestId === 'string' ? payload.requestId : undefined);
  }
 }
 public poll(): Promise<RecoveryStatus> {
  if (this.inFlight) return this.inFlight;
  this.inFlight = this.pollCurrent().catch(error => { if (!this.disposed) this.finish('failed', error instanceof Error ? error.message : 'Recovery probe failed.'); return this.status; }).finally(() => { this.inFlight = undefined; });
  return this.inFlight;
 }
 public dispose(): void {
  this.disposed = true; if (this.statusValue.pending) this.finish('disposed'); if (this.timer) clearTimeout(this.timer); this.timer = undefined;
 }
 private schedule(): void {
  if (this.disposed || this.timer || !this.statusValue.pending || this.options.automatic === false) return;
  this.timer = setTimeout(() => { this.timer = undefined; void this.poll().then(() => this.schedule()); }, 1000);
  this.timer.unref();
 }
 private async pollCurrent(): Promise<RecoveryStatus> {
  if (this.disposed || !this.statusValue.pending) return this.status;
  const now = this.now();
  if (now - this.started >= 60000) { this.finish('inconclusive', 'Recovery deadline elapsed; no command was replayed.'); return this.status; }
  const recorded = this.readValidation();
  const fresh = recorded && this.matchesProject(recorded.projectPath) &&
   (this.editorPid == null || recorded.editorPid === this.editorPid) &&
   typeof recorded.capturedUtc === 'string' && Date.parse(recorded.capturedUtc) >= this.started;
  if (fresh && (recorded.status === 'failed' || Number(recorded.errorCount) > 0)) {
   this.finish('compile_failed', 'Compiler errors require repair; foreground recovery is stopped.'); return this.status;
  }
  const response = await this.sender.request('mcpToolCall', { toolName: 'project_info', args: {} });
  if (this.disposed) return this.status;
  const info = this.payload(response);
  if (info) {
   if (!this.matchesProject(info.projectPath) || (this.editorPid != null && typeof info.editorPid === 'number' && info.editorPid !== this.editorPid)) {
    this.finish('project_mismatch', 'The responding Editor does not match the selected project/process.'); return this.status;
   }
   if (typeof info.editorPid === 'number') this.editorPid = info.editorPid;
   this.lastResponse = this.now(); this.statusValue.bridgeRecovered = true;
   if (!this.statusValue.requestId) { this.finish('recovered', 'A fresh selected-project main-thread response was received; compile success is not implied.'); return this.status; }
   const validation = this.payload(await this.sender.request('mcpToolCall', { toolName: 'editor_validation', args: { action: 'status' } }));
   if (this.disposed) return this.status;
   if (validation && this.matchesProject(validation.projectPath) && validation.requestId === this.statusValue.requestId) {
    if (validation.status === 'failed' || Number(validation.errorCount) > 0) this.finish('compile_failed');
    else if (validation.pending !== true && validation.compileSucceeded === true && validation.success === true) {
     this.statusValue.compileSucceeded = true; this.statusValue.success = true; this.finish('compiled');
    } else if (validation.pending !== true && ['inconclusive', 'blocked'].includes(String(validation.status))) this.finish(String(validation.status));
   }
   return this.status;
  }
  if (this.now() - this.lastResponse >= 5000 && this.statusValue.focusAttempts < 2 &&
      (this.statusValue.focusAttempts === 0 || this.now() - this.lastFocusAt >= 10000) && this.options.focusEditor) {
   this.statusValue.focusAttempts++; this.lastFocusAt = this.now();
   const focus = await this.options.focusEditor(this.options.projectRoot as string, this.editorPid);
   if (this.disposed) return this.status;
   this.statusValue.lastFocus = focus;
   if (focus.pid != null) this.editorPid = focus.pid;
   if (['mismatch', 'ambiguous', 'unsupported', 'not_running', 'not_foreground'].includes(focus.state)) this.finish(focus.state, focus.reason);
   else this.statusValue.state = 'waiting_for_main_thread';
  }
  return this.status;
 }
 private finish(state: string, reason?: string): void {
  this.statusValue.state = state; this.statusValue.pending = false;
  if (reason) this.statusValue.reason = reason;
  if (this.timer) clearTimeout(this.timer); this.timer = undefined;
 }
 private matchesProject(value: unknown): boolean {
  return typeof value === 'string' && this.options.projectRoot != null && path.resolve(value) === path.resolve(this.options.projectRoot);
 }
 private readValidation(): Record<string, unknown> | undefined {
  if (this.options.readValidation) return this.options.readValidation();
  if (!this.options.projectRoot) return undefined;
  // This is an I/O boundary. Stale/missing/malformed files never become completion evidence.
  try {
   const parsed: unknown = JSON.parse(fs.readFileSync(path.join(this.options.projectRoot, 'TestResults/UnityCursorToolkit/EditorValidation/latest.json'), 'utf8'));
   return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
 }
 private payload(response: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!response || response.error === true) return undefined;
  const result = response.result ?? response;
  if (typeof result === 'string') {
   try { const parsed: unknown = JSON.parse(result); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; }
   catch { return undefined; }
  }
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
 }
}
