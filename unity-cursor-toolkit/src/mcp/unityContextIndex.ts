/**
 * Unity context index -- offline Unity asset/meta/object graph for MCP agents.
 *
 * The scanner intentionally extracts stable Unity serialization anchors instead
 * of attempting full YAML round-tripping.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IToolProvider, ToolDefinition, ToolResult } from '../core/interfaces';
import { getToolAnnotations, isDryRun, withDryRunProperty } from './toolMetadata';
import { resolveProjectRoot } from './standaloneProjectTools';

const CONTEXT_FOLDER = '.umetacontext';
const INDEX_FILE = 'index.json';
const SCAN_ROOTS = ['Assets', 'Packages', 'ProjectSettings'] as const;
const TEXT_ASSET_EXTENSIONS = new Set(['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.overridecontroller']);
const MAX_TEXT_BYTES = 2_000_000;
const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_SUMMARY_LIMIT = 40;

export interface UnityContextIndex {
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly projectRoot: string;
	readonly roots: string[];
	readonly stats: UnityContextStats;
	readonly nodes: UnityContextNode[];
	readonly edges: UnityContextEdge[];
	readonly warnings: string[];
}

interface UnityContextStats {
	readonly assets: number;
	readonly metaGuids: number;
	readonly yamlAssets: number;
	readonly objects: number;
	readonly components: number;
	readonly edges: number;
	readonly warnings: number;
}

interface UnityContextNode {
	readonly id: string;
	readonly kind: 'asset' | 'object' | 'component' | 'setting' | 'package';
	readonly path?: string;
	readonly guid?: string;
	readonly fileId?: string;
	readonly classId?: string;
	readonly type?: string;
	readonly name?: string;
	readonly assetPath?: string;
	readonly scenePath?: string;
	readonly gameObjectFileId?: string;
	readonly scriptGuid?: string;
	readonly references?: string[];
}

interface UnityContextEdge {
	readonly from: string;
	readonly to: string;
	readonly type: 'contains' | 'componentOf' | 'references';
	readonly guid?: string;
	readonly fileId?: string;
}

interface ScanState {
	readonly projectRoot: string;
	readonly nodes: UnityContextNode[];
	readonly edges: UnityContextEdge[];
	readonly warnings: string[];
	readonly guidToAsset: Map<string, string>;
	readonly assetNodeIds: Map<string, string>;
}

interface UnityYamlDoc {
	readonly classId: string;
	readonly fileId: string;
	readonly body: string;
}

interface UnityContextQuery {
	readonly terms: string[];
	readonly nodeId: string;
	readonly guid: string;
	readonly path: string;
	readonly name: string;
	readonly classId: string;
	readonly type: string;
	readonly scenePath: string;
	readonly prefabPath: string;
	readonly dependency: string;
}

export class UnityContextMcpTools implements IToolProvider {

	public readonly toolGroupName = 'unity-context';

	constructor(private readonly projectRoot = resolveProjectRoot()) {}

	public getTools(): ToolDefinition[] {
		return [{
			name: 'unity_context',
			title: 'Unity Context',
			description: 'Scan, query, read, or summarize the tracked Unity asset/meta/object context index at .umetacontext/index.json.',
			inputSchema: {
				type: 'object',
				properties: withDryRunProperty({
					action: { type: 'string', enum: ['scan', 'query', 'read', 'summary'], description: 'Defaults to summary.' },
					query: { type: 'string', description: 'Search text for action query.' },
					nodeId: { type: 'string', description: 'Exact node id for action read.' },
					path: { type: 'string', description: 'Asset or scene path for query/read.' },
					guid: { type: 'string', description: 'Unity meta GUID for query/read.' },
					name: { type: 'string', description: 'Unity object or asset name for query/read.' },
					classId: { type: 'string', description: 'Unity serialized class ID filter for query/read.' },
					type: { type: 'string', description: 'Unity asset/object/component type filter for query/read.' },
					scenePath: { type: 'string', description: 'Scene path filter for query/read.' },
					prefabPath: { type: 'string', description: 'Prefab path filter for query/read.' },
					dependency: { type: 'string', description: 'Dependency path, node id, or GUID filter for query.' },
					limit: { type: 'number', description: 'Maximum returned items.' },
					includeEdges: { type: 'boolean', description: 'Include adjacent edges for action read. Defaults to true.' }
				})
			},
			annotations: getToolAnnotations('unity_context')
		}];
	}

	public async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (name !== 'unity_context') {
			return jsonResult({ success: false, error: `Unknown tool: ${name}` }, true);
		}

		const action = getString(args, 'action', 'summary');
		try {
			switch (action) {
				case 'scan':
					return this.scan(args);
				case 'query':
					return jsonResult(queryIndex(await this.loadIndex(), args));
				case 'read':
					return jsonResult(readNode(await this.loadIndex(), args));
				case 'summary':
					return jsonResult(summarizeIndex(await this.loadIndex(), args));
				default:
					return jsonResult({ success: false, error: `Unknown unity_context action: ${action}` }, true);
			}
		} catch (error) {
			return jsonResult({ success: false, error: error instanceof Error ? error.message : String(error) }, true);
		}
	}

	private async scan(args: Record<string, unknown>): Promise<ToolResult> {
		const index = await scanUnityProject(this.projectRoot);
		const indexPath = getIndexPath(this.projectRoot);

		if (isDryRun(args)) {
			return jsonResult({
				success: true,
				dryRun: true,
				wouldWrite: indexPath,
				stats: index.stats,
				warnings: index.warnings
			});
		}

		await fs.mkdir(path.dirname(indexPath), { recursive: true });
		await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
		return jsonResult({
			success: true,
			path: indexPath,
			stats: index.stats,
			warnings: index.warnings
		});
	}

	private async loadIndex(): Promise<UnityContextIndex> {
		const indexPath = getIndexPath(this.projectRoot);
		try {
			const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8')) as UnityContextIndex;
			if (parsed.schemaVersion !== 1 || Array.isArray(parsed.nodes) === false || Array.isArray(parsed.edges) === false) {
				throw new Error('Unsupported index schema.');
			}
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`No Unity context index found. Run unity_context with action "scan" first: ${indexPath}`);
			}
			throw error;
		}
	}
}

export async function scanUnityProject(projectRoot: string): Promise<UnityContextIndex> {
	const root = path.resolve(projectRoot);
	const state: ScanState = {
		projectRoot: root,
		nodes: [],
		edges: [],
		warnings: [],
		guidToAsset: new Map<string, string>(),
		assetNodeIds: new Map<string, string>()
	};

	const roots: string[] = [];
	for (const scanRoot of SCAN_ROOTS) {
		const absolute = path.join(root, scanRoot);
		if (await exists(absolute)) {
			roots.push(scanRoot);
		}
	}

	const files: string[] = [];
	for (const scanRoot of roots) {
		await walkFiles(path.join(root, scanRoot), files);
	}

	await collectMetaGuids(state, files);
	await collectAssets(state, files);

	for (const file of files) {
		await parseSerializedAsset(state, file);
	}

	const stats: UnityContextStats = {
		assets: state.nodes.filter((node) => node.kind === 'asset' || node.kind === 'setting' || node.kind === 'package').length,
		metaGuids: state.guidToAsset.size,
		yamlAssets: unique(state.nodes.filter((node) => node.kind === 'object' || node.kind === 'component').map((node) => node.assetPath ?? '')).length,
		objects: state.nodes.filter((node) => node.kind === 'object').length,
		components: state.nodes.filter((node) => node.kind === 'component').length,
		edges: state.edges.length,
		warnings: state.warnings.length
	};

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		projectRoot: root,
		roots,
		stats,
		nodes: state.nodes,
		edges: state.edges,
		warnings: state.warnings
	};
}

function queryIndex(index: UnityContextIndex, args: Record<string, unknown>): Record<string, unknown> {
	const limit = getLimit(args, DEFAULT_QUERY_LIMIT);
	const query = buildContextQuery(args);
	const matches = index.nodes
		.filter((node) => nodeMatchesQuery(index, node, query))
		.slice(0, limit);

	return {
		success: true,
		count: matches.length,
		totalNodes: index.nodes.length,
		nodes: matches.map(compactNode)
	};
}

function readNode(index: UnityContextIndex, args: Record<string, unknown>): Record<string, unknown> {
	const node = findNode(index, args);
	if (node == null) {
		return { success: false, error: 'No matching Unity context node found.' };
	}

	const includeEdges = args.includeEdges !== false;
	const edges = includeEdges
		? index.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
		: [];
	const adjacentIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]).filter((id) => id !== node.id));
	const adjacent = index.nodes.filter((candidate) => adjacentIds.has(candidate.id)).map(compactNode);

	return {
		success: true,
		node,
		edges,
		adjacent
	};
}

function summarizeIndex(index: UnityContextIndex, args: Record<string, unknown>): Record<string, unknown> {
	const limit = getLimit(args, DEFAULT_SUMMARY_LIMIT);
	const scenes = index.nodes.filter((node) => node.path?.endsWith('.unity')).slice(0, limit).map(compactNode);
	const packages = index.nodes.filter((node) => node.path?.startsWith('Packages/')).slice(0, limit).map(compactNode);
	const scripts = index.nodes.filter((node) => node.path?.endsWith('.cs')).slice(0, limit).map(compactNode);
	const namedObjects = index.nodes.filter((node) => node.kind === 'object' && node.name).slice(0, limit).map(compactNode);

	return {
		success: true,
		generatedAt: index.generatedAt,
		projectRoot: index.projectRoot,
		stats: index.stats,
		scenes,
		packages,
		scripts,
		namedObjects,
		warnings: index.warnings.slice(0, limit)
	};
}

async function collectMetaGuids(state: ScanState, files: readonly string[]): Promise<void> {
	for (const file of files) {
		if (file.endsWith('.meta') === false) {
			continue;
		}
		const content = await safeReadText(state, file);
		if (content == null) {
			continue;
		}
		const guid = /^guid:\s*([a-fA-F0-9]{32})/m.exec(content)?.[1]?.toLowerCase();
		if (guid == null) {
			continue;
		}
		state.guidToAsset.set(guid, toRelativeAssetPath(state.projectRoot, file).replace(/\.meta$/i, ''));
	}
}

async function collectAssets(state: ScanState, files: readonly string[]): Promise<void> {
	for (const file of files) {
		if (file.endsWith('.meta')) {
			continue;
		}

		const rel = toRelativeAssetPath(state.projectRoot, file);
		const guid = findGuidForAsset(state.guidToAsset, rel);
		const node: UnityContextNode = {
			id: `asset:${rel}`,
			kind: classifyAssetNode(rel),
			path: rel,
			guid,
			type: classifyAssetType(rel)
		};
		state.nodes.push(node);
		state.assetNodeIds.set(rel, node.id);
	}
}

async function parseSerializedAsset(state: ScanState, file: string): Promise<void> {
	const ext = path.extname(file).toLowerCase();
	if (TEXT_ASSET_EXTENSIONS.has(ext) === false) {
		return;
	}

	const stat = await fs.stat(file);
	if (stat.size > MAX_TEXT_BYTES) {
		state.warnings.push(`Skipped large serialized asset: ${toRelativeAssetPath(state.projectRoot, file)}`);
		return;
	}

	const content = await safeReadText(state, file);
	if (content == null || content.includes('--- !u!') === false) {
		return;
	}

	const rel = toRelativeAssetPath(state.projectRoot, file);
	const assetNodeId = state.assetNodeIds.get(rel) ?? `asset:${rel}`;
	const docs = parseUnityYamlDocs(content);
	const gameObjects = new Map<string, string>();

	for (const doc of docs) {
		if (doc.classId === '1') {
			const objectNode = buildObjectNode(rel, doc);
			state.nodes.push(objectNode);
			state.edges.push({ from: assetNodeId, to: objectNode.id, type: 'contains', fileId: doc.fileId });
			gameObjects.set(doc.fileId, objectNode.id);
		}
	}

	for (const doc of docs) {
		if (doc.classId === '1') {
			addReferenceEdges(state, rel, `object:${rel}:${doc.fileId}`, doc.body);
			continue;
		}

		const gameObjectFileId = /^\s*m_GameObject:\s*\{fileID:\s*(-?\d+)/m.exec(doc.body)?.[1];
		if (gameObjectFileId == null && doc.body.includes('guid:') === false) {
			continue;
		}

		const componentNode = buildComponentNode(rel, doc, gameObjectFileId);
		state.nodes.push(componentNode);
		state.edges.push({ from: assetNodeId, to: componentNode.id, type: 'contains', fileId: doc.fileId });
		if (gameObjectFileId != null) {
			const objectId = gameObjects.get(gameObjectFileId) ?? `object:${rel}:${gameObjectFileId}`;
			state.edges.push({ from: componentNode.id, to: objectId, type: 'componentOf', fileId: gameObjectFileId });
		}
		addReferenceEdges(state, rel, componentNode.id, doc.body);
	}
}

function buildObjectNode(assetPath: string, doc: UnityYamlDoc): UnityContextNode {
	const name = extractName(doc.body);
	return {
		id: `object:${assetPath}:${doc.fileId}`,
		kind: 'object',
		assetPath,
		scenePath: assetPath.endsWith('.unity') ? assetPath : undefined,
		fileId: doc.fileId,
		classId: doc.classId,
		type: unityClassName(doc.classId),
		name,
		references: extractGuids(doc.body)
	};
}

function buildComponentNode(assetPath: string, doc: UnityYamlDoc, gameObjectFileId: string | undefined): UnityContextNode {
	const scriptGuid = /^\s*m_Script:\s*\{fileID:\s*-?\d+,\s*guid:\s*([a-fA-F0-9]{32})/m.exec(doc.body)?.[1]?.toLowerCase();
	return {
		id: `component:${assetPath}:${doc.fileId}`,
		kind: 'component',
		assetPath,
		scenePath: assetPath.endsWith('.unity') ? assetPath : undefined,
		fileId: doc.fileId,
		classId: doc.classId,
		type: scriptGuid ? 'MonoBehaviour' : unityClassName(doc.classId),
		name: extractName(doc.body),
		gameObjectFileId,
		scriptGuid,
		references: extractGuids(doc.body)
	};
}

function addReferenceEdges(state: ScanState, assetPath: string, from: string, body: string): void {
	for (const guid of extractGuids(body)) {
		const targetPath = state.guidToAsset.get(guid);
		state.edges.push({
			from,
			to: targetPath ? `asset:${targetPath}` : `guid:${guid}`,
			type: 'references',
			guid
		});
	}
	if (body.includes('guid:') && extractGuids(body).length === 0) {
		state.warnings.push(`Serialized references were present but not parsed in ${assetPath}.`);
	}
}

function parseUnityYamlDocs(content: string): UnityYamlDoc[] {
	const docs: UnityYamlDoc[] = [];
	const marker = /^--- !u!(\d+)\s+&(-?\d+)/gm;
	const matches = Array.from(content.matchAll(marker));

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const next = matches[i + 1];
		docs.push({
			classId: match[1],
			fileId: match[2],
			body: content.slice((match.index ?? 0) + match[0].length, next?.index ?? content.length)
		});
	}

	return docs;
}

function extractName(body: string): string | undefined {
	const raw = /^\s*m_Name:\s*(.*)$/m.exec(body)?.[1]?.trim();
	return raw && raw.length > 0 ? raw : undefined;
}

function extractGuids(body: string): string[] {
	return unique(Array.from(body.matchAll(/guid:\s*([a-fA-F0-9]{32})/g)).map((match) => match[1].toLowerCase()));
}

function findGuidForAsset(guidToAsset: Map<string, string>, rel: string): string | undefined {
	for (const [guid, assetPath] of guidToAsset) {
		if (assetPath === rel) {
			return guid;
		}
	}
	return undefined;
}

async function walkFiles(dir: string, files: string[]): Promise<void> {
	let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(full, files);
		} else if (entry.isFile()) {
			files.push(full);
		}
	}
}

async function safeReadText(state: ScanState, file: string): Promise<string | null> {
	try {
		const buffer = await fs.readFile(file);
		if (buffer.includes(0)) {
			return null;
		}
		return buffer.toString('utf8');
	} catch (error) {
		state.warnings.push(`Could not read ${toRelativeAssetPath(state.projectRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function getIndexPath(projectRoot: string): string {
	return path.join(path.resolve(projectRoot), CONTEXT_FOLDER, INDEX_FILE);
}

function toRelativeAssetPath(projectRoot: string, file: string): string {
	return path.relative(path.resolve(projectRoot), path.resolve(file)).split(path.sep).join('/');
}

function classifyAssetNode(rel: string): UnityContextNode['kind'] {
	if (rel.startsWith('ProjectSettings/')) {
		return 'setting';
	}
	if (rel.startsWith('Packages/')) {
		return 'package';
	}
	return 'asset';
}

function classifyAssetType(rel: string): string {
	const ext = path.extname(rel).toLowerCase();
	if (rel.endsWith('/package.json')) return 'packageManifest';
	if (rel.endsWith('.asmdef')) return 'assemblyDefinition';
	if (ext === '.unity') return 'scene';
	if (ext === '.prefab') return 'prefab';
	if (ext === '.mat') return 'material';
	if (ext === '.cs') return 'script';
	if (ext === '.asset') return 'asset';
	return ext.length > 0 ? ext.slice(1) : 'file';
}

function unityClassName(classId: string): string {
	switch (classId) {
		case '1': return 'GameObject';
		case '4': return 'Transform';
		case '20': return 'Camera';
		case '23': return 'MeshRenderer';
		case '33': return 'MeshFilter';
		case '65': return 'BoxCollider';
		case '81': return 'AudioListener';
		case '108': return 'Light';
		case '114': return 'MonoBehaviour';
		case '224': return 'RectTransform';
		case '225': return 'CanvasGroup';
		case '223': return 'Canvas';
		default: return `UnityClass${classId}`;
	}
}

function compactNode(node: UnityContextNode): Record<string, unknown> {
	return {
		id: node.id,
		kind: node.kind,
		path: node.path,
		guid: node.guid,
		fileId: node.fileId,
		classId: node.classId,
		type: node.type,
		name: node.name,
		assetPath: node.assetPath,
		scenePath: node.scenePath,
		scriptGuid: node.scriptGuid
	};
}

function findNode(index: UnityContextIndex, args: Record<string, unknown>): UnityContextNode | undefined {
	const query = buildContextQuery(args);
	if (query.nodeId.length > 0) {
		return index.nodes.find((node) => node.id === query.nodeId);
	}

	if (query.guid.length > 0) {
		return index.nodes.find((node) => node.guid === query.guid || node.scriptGuid === query.guid || node.references?.includes(query.guid));
	}

	if (query.path.length > 0) {
		return index.nodes.find((node) => node.path?.toLowerCase() === query.path || node.assetPath?.toLowerCase() === query.path);
	}

	if (query.scenePath.length > 0) {
		return index.nodes.find((node) => node.scenePath?.toLowerCase() === query.scenePath || node.path?.toLowerCase() === query.scenePath);
	}

	if (query.prefabPath.length > 0) {
		return index.nodes.find((node) => node.path?.toLowerCase() === query.prefabPath || node.assetPath?.toLowerCase() === query.prefabPath);
	}

	if (query.classId.length > 0) {
		return index.nodes.find((node) => node.classId?.toLowerCase() === query.classId);
	}

	if (query.type.length > 0) {
		return index.nodes.find((node) => node.type?.toLowerCase() === query.type);
	}

	if (query.name.length > 0) {
		return index.nodes.find((node) => node.name?.toLowerCase() === query.name);
	}

	if (query.terms.length > 0) {
		return index.nodes.find((node) => nodeMatchesQuery(index, node, query));
	}

	return undefined;
}

function buildContextQuery(args: Record<string, unknown>): UnityContextQuery {
	return {
		terms: splitTerms(getString(args, 'query', '')),
		nodeId: getString(args, 'nodeId', ''),
		guid: getString(args, 'guid', '').toLowerCase(),
		path: getString(args, 'path', '').toLowerCase(),
		name: getString(args, 'name', '').toLowerCase(),
		classId: getString(args, 'classId', '').toLowerCase(),
		type: getString(args, 'type', '').toLowerCase(),
		scenePath: getString(args, 'scenePath', '').toLowerCase(),
		prefabPath: getString(args, 'prefabPath', '').toLowerCase(),
		dependency: getString(args, 'dependency', getString(args, 'dependencyGuid', '')).toLowerCase()
	};
}

function nodeMatchesQuery(index: UnityContextIndex, node: UnityContextNode, query: UnityContextQuery): boolean {
	if (query.terms.length > 0 && query.terms.every((term) => nodeMatches(node, term)) === false) {
		return false;
	}
	if (query.guid.length > 0 && nodeMatchesGuid(node, query.guid) === false) {
		return false;
	}
	if (query.path.length > 0 && [node.path, node.assetPath].some((value) => stringMatches(value, query.path)) === false) {
		return false;
	}
	if (query.name.length > 0 && stringMatches(node.name, query.name) === false) {
		return false;
	}
	if (query.classId.length > 0 && node.classId?.toLowerCase() !== query.classId) {
		return false;
	}
	if (query.type.length > 0 && node.type?.toLowerCase().includes(query.type) !== true) {
		return false;
	}
	if (query.scenePath.length > 0 && [node.scenePath, node.assetPath, node.path].some((value) => stringMatches(value, query.scenePath)) === false) {
		return false;
	}
	if (query.prefabPath.length > 0 && [node.assetPath, node.path].some((value) => stringMatches(value, query.prefabPath) && value?.endsWith('.prefab')) === false) {
		return false;
	}
	if (query.dependency.length > 0 && nodeDependsOn(index, node, query.dependency) === false) {
		return false;
	}
	return true;
}

function nodeMatchesGuid(node: UnityContextNode, guid: string): boolean {
	return node.guid === guid || node.scriptGuid === guid || node.references?.includes(guid) === true;
}

function nodeDependsOn(index: UnityContextIndex, node: UnityContextNode, dependency: string): boolean {
	if ((node.references ?? []).some((guid) => guid.toLowerCase().includes(dependency))) {
		return true;
	}

	const outgoing = index.edges.filter((edge) => edge.from === node.id && edge.type === 'references');
	for (const edge of outgoing) {
		if (stringMatches(edge.guid, dependency) || stringMatches(edge.to, dependency)) {
			return true;
		}
		const target = index.nodes.find((candidate) => candidate.id === edge.to);
		if (target && nodeMatches(target, dependency)) {
			return true;
		}
	}
	return false;
}

function nodeMatches(node: UnityContextNode, term: string): boolean {
	return [
		node.id,
		node.path,
		node.guid,
		node.fileId,
		node.classId,
		node.type,
		node.name,
		node.assetPath,
		node.scenePath,
		node.gameObjectFileId,
		node.scriptGuid,
		...(node.references ?? [])
	].some((value) => typeof value === 'string' && value.toLowerCase().includes(term));
}

function stringMatches(value: string | undefined, term: string): boolean {
	return typeof value === 'string' && value.toLowerCase().includes(term);
}

function splitTerms(value: string): string[] {
	return value
		.split(/\s+/)
		.map((term) => term.trim().toLowerCase())
		.filter((term) => term.length > 0);
}

function getString(args: Record<string, unknown>, key: string, fallback: string): string {
	const value = args[key];
	return typeof value === 'string' ? value : fallback;
}

function getLimit(args: Record<string, unknown>, fallback: number): number {
	const value = args.limit;
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.min(Math.floor(value), 200)
		: fallback;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function jsonResult(payload: Record<string, unknown>, isError = false): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		isError: isError || payload.success === false || false
	};
}
