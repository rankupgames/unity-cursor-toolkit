/** Runtime fields advertised by project_info. No Unity version inference. */
export interface RuntimeCapabilities {
	readonly isCoreCLR: boolean;
	readonly hasDomainReload: boolean;
	readonly source: 'handshake' | 'legacy';
}

export class RuntimeCapabilityError extends Error {
	public readonly code = 'capability_unavailable';
	public constructor(public readonly capability: string, message: string) {
		super(message);
		this.name = 'RuntimeCapabilityError';
	}
}

export function parseRuntimeCapabilities(projectInfo: unknown): RuntimeCapabilities {
	if (typeof projectInfo !== 'object' || projectInfo == null || Array.isArray(projectInfo)) {
		throw new RuntimeCapabilityError('runtime', 'Project information is invalid. Runtime features are unavailable. Reconnect to Unity.');
	}
	if (!Object.prototype.hasOwnProperty.call(projectInfo, 'runtime')) {
		// Shipped packages before the runtime handshake used Mono with domain reload support.
		return { isCoreCLR: false, hasDomainReload: true, source: 'legacy' };
	}
	const runtime = (projectInfo as { runtime?: unknown }).runtime;
	if (typeof runtime !== 'object' || runtime == null || Array.isArray(runtime)) {
		throw new RuntimeCapabilityError('runtime', 'Runtime capabilities are invalid. Runtime features are unavailable. Update the Unity package.');
	}
	const { isCoreCLR, hasDomainReload } = runtime as Record<string, unknown>;
	if (typeof isCoreCLR !== 'boolean' || typeof hasDomainReload !== 'boolean' || (isCoreCLR && hasDomainReload)) {
		throw new RuntimeCapabilityError('runtime', 'Runtime capabilities are incomplete or inconsistent. Runtime features are unavailable. Update the Unity package.');
	}
	return { isCoreCLR, hasDomainReload, source: 'handshake' };
}

export function getReloadSemantics(runtime: RuntimeCapabilities): 'domain-reload' | 'explicit-cleanup' {
	if (runtime.isCoreCLR) return 'explicit-cleanup';
	if (runtime.hasDomainReload) return 'domain-reload';
	throw new RuntimeCapabilityError('hasDomainReload', 'The runtime is unknown. Reload features are unavailable. Update the Unity package.');
}

export function getHotReloadMode(runtime: RuntimeCapabilities): 'il-patch' | 'unity-reload' {
	return getReloadSemantics(runtime) === 'domain-reload' ? 'il-patch' : 'unity-reload';
}

export function getDebuggerType(runtime: RuntimeCapabilities): 'unityCursorToolkit.debug' {
	if (getReloadSemantics(runtime) === 'domain-reload') return 'unityCursorToolkit.debug';
	throw new RuntimeCapabilityError('monoDebugger', 'CoreCLR is active. The Mono debugger is unavailable. Use a debugger that supports this Editor.');
}
