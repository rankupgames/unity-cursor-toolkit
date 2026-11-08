/** Shared internal test snapshot used by CLI and bridge backends. */
export type UnityTestMode = 'EditMode' | 'PlayMode';
export type UnityTestStatus = 'passed' | 'failed' | 'skipped' | 'inconclusive' | 'not_run';
export type UnityTestRunStatus = 'listed' | 'discovering' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'error';

export interface UnityTestFilters {
	assembly?: string;
	namespace?: string;
	class?: string;
	test?: string;
	category?: string;
}
export interface UnityTestCase {
	id: string;
	fullName: string;
	status: UnityTestStatus;
	durationMs: number;
	message: string;
	stackTrace: string;
}
export interface UnityTestSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	inconclusive: number;
	notRun: number;
	durationMs: number;
}
export interface UnityTestError {
	code: string;
	message: string;
	recovery: string;
	nativeCode?: string;
	exitCode?: number | null;
}
export interface UnityTestSnapshot {
	success: boolean;
	backend: 'cli' | 'bridge';
	runId: string;
	status: UnityTestRunStatus;
	editorVersion: string;
	/** Null only when an invalid request supplied no supported mode. */
	mode: UnityTestMode | null;
	selection: string[];
	tests: UnityTestCase[];
	summary: UnityTestSummary;
	error?: UnityTestError;
}
export interface UnityTestRequest {
	projectPath: string;
	mode: UnityTestMode;
	filters?: UnityTestFilters;
	timeoutMs: number;
	signal?: AbortSignal;
	dryRun?: boolean;
	outputFormat?: 'json';
	onSelected?: (editorVersion: string) => void;
}
