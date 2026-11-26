/** Event-driven tail of the selected project's bounded session journal. No idle polling. */
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

export class SessionJournalWatcher {
 private readonly projectRoot: string | undefined;
 private readonly emit: (event: Record<string, unknown>) => void;
 private watcher: fs.FSWatcher | undefined;
 private watchedDirectory = '';
 private offset = 0;
 private partial = '';
 private decoder = new StringDecoder('utf8');
 private lastSequence = 0;
 private active = false;
 private queued = false;
 private lastError = '';
 constructor(projectRoot: string | undefined, emit: (event: Record<string, unknown>) => void) {
  this.projectRoot = projectRoot ? path.resolve(projectRoot) : undefined; this.emit = emit;
 }
 public get status(): Record<string, unknown> { return { watching: this.active, afterSequence: this.lastSequence, error: this.lastError || undefined }; }
 public start(afterSequence?: number): Record<string, unknown> {
  if (!this.projectRoot) return { success: false, error: 'project_required: set UNITY_CURSOR_TOOLKIT_PROJECT_PATH.' };
  if (afterSequence != null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) return { success: false, error: 'invalid_sequence' };
  if (this.active) return { success: true, ...this.status };
  this.active = true; this.partial = ''; this.decoder = new StringDecoder('utf8'); this.lastError = ''; this.lastSequence = afterSequence ?? 0;
  const file = this.file();
  this.offset = afterSequence == null && fs.existsSync(file) ? fs.statSync(file).size : 0;
  this.attach(); this.queueRead();
  return { success: this.active, ...this.status };
 }
 public stop(): Record<string, unknown> {
  this.active = false; this.watcher?.close(); this.watcher = undefined; this.watchedDirectory = '';
  this.partial = ''; return { success: true, ...this.status };
 }
 public dispose(): void { this.stop(); }
 private file(): string { return path.join(this.projectRoot as string, 'Library/UnityCursorToolkit/PlaySessions/events.jsonl'); }
 private attach(): void {
  if (!this.active) return;
  try {
   let directory = path.dirname(this.file());
   while (!fs.existsSync(directory) && directory !== this.projectRoot) directory = path.dirname(directory);
   const realRoot = fs.realpathSync(this.projectRoot as string);
   const realDirectory = fs.realpathSync(directory);
   const relative = path.relative(realRoot, realDirectory);
   if (relative.startsWith('..') || path.isAbsolute(relative)) { this.fail('journal_path_outside_project'); return; }
   if (directory === this.watchedDirectory) return;
   this.watcher?.close(); this.watchedDirectory = directory;
   this.watcher = fs.watch(directory, () => { this.attach(); this.queueRead(); });
   this.watcher.on('error', () => this.fail('journal_watch_failed'));
  } catch { this.fail('journal_watch_failed'); }
 }
 private queueRead(): void {
  if (this.queued || !this.active) return;
  this.queued = true;
  queueMicrotask(() => { this.queued = false; if (this.active) this.readAvailable(); });
 }
 private readAvailable(): void {
  try {
   const file = this.file(); if (!fs.existsSync(file)) return;
   const relative = path.relative(fs.realpathSync(this.projectRoot as string), fs.realpathSync(file));
   if (relative.startsWith('..') || path.isAbsolute(relative)) { this.fail('journal_path_outside_project'); return; }
   const size = fs.statSync(file).size;
   if (size < this.offset) { this.emit({ kind: 'journal_reset', afterSequence: this.lastSequence }); this.offset = 0; this.partial = ''; this.decoder = new StringDecoder('utf8'); }
   if (size === this.offset) return;
   const buffer = Buffer.alloc(Math.min(size - this.offset, 256 * 1024));
   const fd = fs.openSync(file, 'r');
   let read = 0;
   try { read = fs.readSync(fd, buffer, 0, buffer.length, this.offset); } finally { fs.closeSync(fd); }
   this.offset += read; this.partial += this.decoder.write(buffer.subarray(0, read));
   const lines = this.partial.split('\n'); this.partial = lines.pop() ?? '';
   for (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 65536) { this.fail('journal_event_limit'); return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { this.fail('journal_invalid_json'); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.version !== 1 ||
        !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1 || typeof event.kind !== 'string' || typeof event.sessionId !== 'string') {
     this.fail('journal_invalid_event'); return;
    }
    const sequence = Number(event.sequence); if (sequence <= this.lastSequence) continue;
    if (this.lastSequence > 0 && sequence > this.lastSequence + 1) this.emit({ kind: 'event_gap', expectedSequence: this.lastSequence + 1, observedSequence: sequence });
    this.lastSequence = sequence; this.emit(event);
   }
   if (this.partial.length > 65536) { this.fail('journal_event_limit'); return; }
   if (this.offset < size) this.queueRead();
  } catch { this.fail('journal_read_failed'); }
 }
 private fail(error: string): void {
  if (!this.active) return;
  this.lastError = error; this.emit({ kind: 'watch_error', error }); this.stop();
 }
}
