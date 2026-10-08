import * as https from 'https';
import { readUnityProjectVersion } from './unityEditorLauncher';

export const PIPELINE_REGISTRY_URL = 'https://packages.unity.com/com.unity.pipeline';
const MIN_RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PipelineRegistrySnapshot {
	url: string;
	checkedAt: string;
	httpDate: string | null;
	metadata: unknown;
}

export type PipelineEligibilityResult = {
	ok: true;
	packageVersion: string;
	publishedAt: string;
	checkedAt: string;
	ageMs: number;
	declaredEditorVersion: string;
	minimumEditorVersion: string;
	registryUrl: string;
	httpDate: string;
} | {
	ok: false;
	error: {
		code: 'pipeline_project_version_invalid' | 'pipeline_pin_invalid' | 'pipeline_registry_unavailable'
			| 'pipeline_metadata_invalid' | 'pipeline_version_unavailable' | 'pipeline_version_too_recent' | 'pipeline_editor_unsupported';
		message: string;
		requestedVersion: string;
		declaredEditorVersion?: string;
		minimumEditorVersion?: string;
		publishedAt?: string;
		checkedAt?: string;
	};
};

/** Anonymous official registry query. No credentials, redirects, writes or floating selection. */
export function queryPipelineRegistry(): Promise<PipelineRegistrySnapshot> {
	return new Promise((resolve, reject) => {
		let bytes = 0, body = '', done = false;
		const finish = (error?: Error): void => {
			if (done) { return; }
			done = true; clearTimeout(deadline);
			if (error) { reject(error); return; }
			try { resolve({ url: PIPELINE_REGISTRY_URL, checkedAt: new Date().toISOString(), httpDate, metadata: JSON.parse(body) }); }
			catch { reject(new Error('Registry did not return complete JSON.')); }
		};
		let httpDate: string | null = null;
		const request = https.get(PIPELINE_REGISTRY_URL, { headers: { Accept: 'application/json' } }, response => {
			if (response.statusCode !== 200) {
				response.resume(); finish(new Error('Registry returned HTTP ' + response.statusCode + '.')); return;
			}
			httpDate = response.headers.date || null;
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				bytes += Buffer.byteLength(chunk);
				if (bytes > 1024 * 1024) { request.destroy(new Error('Registry response exceeded the bound.')); return; }
				body += chunk;
			});
			response.once('end', () => finish());
			response.once('error', error => finish(error));
			response.once('aborted', () => finish(new Error('Registry response was interrupted.')));
		});
		const deadline = setTimeout(() => request.destroy(new Error('Registry deadline exceeded.')), 15000);
		request.once('error', error => finish(error));
	});
}

function requestError(declaredEditorVersion: string | null, requestedVersion: string): PipelineEligibilityResult | undefined {
	if (!declaredEditorVersion) {
		return { ok: false, error: { code: 'pipeline_project_version_invalid', message: 'The declared project Editor version is missing or invalid.', requestedVersion } };
	}
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(requestedVersion)) {
		return { ok: false, error: { code: 'pipeline_pin_invalid', message: 'Pipeline requires one exact package version, without aliases or ranges.', requestedVersion, declaredEditorVersion } };
	}
	return undefined;
}

/** Gate only: reads the declared version and fresh metadata before any install writer. */
export async function checkPipelineEligibility(projectPath: string, requestedVersion: string): Promise<PipelineEligibilityResult> {
	const declared = readUnityProjectVersion(projectPath);
	const invalid = requestError(declared, requestedVersion);
	if (invalid) { return invalid; }
	try { return evaluatePipelineEligibility(declared, requestedVersion, await queryPipelineRegistry()); }
	catch { return { ok: false, error: { code: 'pipeline_registry_unavailable', message: 'Fresh Pipeline registry metadata could not be queried.', requestedVersion, declaredEditorVersion: declared! } }; }
}

/** Same decision used by the gate and the evidence recorder's freshly queried snapshot. */
export function evaluatePipelineEligibility(declaredEditorVersion: string | null, requestedVersion: string, snapshot: PipelineRegistrySnapshot): PipelineEligibilityResult {
	const invalid = requestError(declaredEditorVersion, requestedVersion);
	if (invalid) { return invalid; }
	const refuse = (code: Extract<PipelineEligibilityResult, { ok: false }>['error']['code'], message: string,
		details: Partial<Extract<PipelineEligibilityResult, { ok: false }>['error']> = {}): PipelineEligibilityResult =>
		({ ok: false, error: { code, message, requestedVersion, declaredEditorVersion: declaredEditorVersion!, ...details } });
	const metadata = snapshot.metadata as { name?: unknown; versions?: Record<string, { unity?: unknown; unityRelease?: unknown }>; time?: Record<string, unknown> } | null;
	const versions = metadata?.versions, times = metadata?.time;
	if (snapshot.url !== PIPELINE_REGISTRY_URL || metadata?.name !== 'com.unity.pipeline'
		|| !versions || Array.isArray(versions) || typeof versions !== 'object'
		|| !times || Array.isArray(times) || typeof times !== 'object') {
		return refuse('pipeline_metadata_invalid', 'Pipeline registry version and publication metadata is incomplete.');
	}
	if (!Object.prototype.hasOwnProperty.call(versions, requestedVersion)) {
		return refuse('pipeline_version_unavailable', 'Requested Pipeline version ' + requestedVersion + ' is not available.');
	}
	const selected = versions[requestedVersion], publishedAt = times[requestedVersion];
	const minimum = typeof selected?.unity === 'string' ? /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(selected.unity) : null;
	const declared = /^(\d+)\.(\d+)\.(\d+)/.exec(declaredEditorVersion!);
	const canonicalTime = (value: unknown): number => {
		if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) { return NaN; }
		const milliseconds = Date.parse(value);
		return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : NaN;
	};
	const publishedMs = canonicalTime(publishedAt), checkedMs = canonicalTime(snapshot.checkedAt);
	const serverMs = snapshot.httpDate == null ? NaN : Date.parse(snapshot.httpDate);
	if (!minimum || !declared || selected?.unityRelease != null || !Number.isFinite(publishedMs) || !Number.isFinite(checkedMs)
		|| !Number.isFinite(serverMs) || new Date(serverMs).toUTCString() !== snapshot.httpDate) {
		return refuse('pipeline_metadata_invalid', 'The selected Pipeline publication time, registry date or Editor minimum is missing or invalid.');
	}
	const minimumEditorVersion = selected.unity as string;
	const details = { minimumEditorVersion, publishedAt: publishedAt as string, checkedAt: snapshot.checkedAt };
	const installedParts = declared.slice(1).map(Number), minimumParts = [minimum[1], minimum[2], minimum[3] || '0'].map(Number);
	if (![...installedParts, ...minimumParts].every(Number.isSafeInteger)) {
		return refuse('pipeline_metadata_invalid', 'The declared or minimum Editor version cannot be compared safely.', details);
	}
	const different = installedParts.findIndex((part, index) => part !== minimumParts[index]);
	if (different >= 0 && installedParts[different] < minimumParts[different]) {
		return refuse('pipeline_editor_unsupported', 'Declared Editor ' + declaredEditorVersion + ' is below Pipeline minimum ' + minimumEditorVersion + '.', details);
	}
	// Both clocks must clear the age gate. A local clock ahead cannot approve a fresh package.
	const ageMs = Math.min(checkedMs, serverMs) - publishedMs;
	if (ageMs < MIN_RELEASE_AGE_MS) {
		return refuse('pipeline_version_too_recent', 'Pipeline ' + requestedVersion + ' must be published at least seven days before installation.', details);
	}
	return { ok: true, packageVersion: requestedVersion, declaredEditorVersion: declaredEditorVersion!, ...details, ageMs,
		registryUrl: snapshot.url, httpDate: snapshot.httpDate! };
}
