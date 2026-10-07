#!/usr/bin/env node
// The root UPM package owns the sample project's embedded copy.
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const packageName = 'com.rankupgames.unity-cursor-toolkit';
const sourceRoot = path.join(repositoryRoot, 'Packages', packageName);
const targetRoot = path.join(repositoryRoot, 'CursorUnityTool', 'Packages', packageName);

function collect(root) {
	const entries = new Map();
	function visit(relativePath) {
		const absolutePath = path.join(root, relativePath);
		const stat = fs.lstatSync(absolutePath);
		if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || (!stat.isFile() && !stat.isDirectory())) {
			throw new Error(`Unsupported package entry: ${absolutePath}. Remove it before syncing.`);
		}
		entries.set(relativePath, stat);
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(absolutePath).sort()) {
				visit(path.join(relativePath, name));
			}
		}
	}
	visit('');
	return entries;
}

function main() {
	const args = process.argv.slice(2);
	if (args.some(arg => arg !== '--check')) {
		throw new Error('Unknown argument. Use sync:package with only the optional --check flag.');
	}
	// Reject redirected ancestors before reading or writing either package.
	for (const relativePath of ['Packages', 'CursorUnityTool', 'CursorUnityTool/Packages']) {
		const stat = fs.lstatSync(path.join(repositoryRoot, relativePath));
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`Expected a real directory: ${relativePath}. Restore it before syncing.`);
		}
	}
	const source = collect(sourceRoot);
	const target = fs.existsSync(targetRoot) ? collect(targetRoot) : new Map();
	if (!source.get('').isDirectory() || (target.has('') && !target.get('').isDirectory())) {
		throw new Error('Package roots must be directories. Restore them before syncing.');
	}
	const paths = [...new Set([...source.keys(), ...target.keys()])].sort();
	const changed = paths.filter(relativePath => {
		const left = source.get(relativePath);
		const right = target.get(relativePath);
		if (!left || !right || left.isDirectory() !== right.isDirectory()) return true;
		return left.isFile() && (
			(left.mode & 0o111) !== (right.mode & 0o111) ||
			!fs.readFileSync(path.join(sourceRoot, relativePath)).equals(fs.readFileSync(path.join(targetRoot, relativePath)))
		);
	});
	for (const relativePath of changed) {
		console.log(`${!source.has(relativePath) ? 'delete' : !target.has(relativePath) ? 'add' : 'update'} ${relativePath || '.'}`);
	}
	if (args.includes('--check')) {
		process.exitCode = changed.length === 0 ? 0 : 1;
	} else {
		// Remove obsolete entries and type conflicts, children before parents.
		for (const relativePath of [...changed].reverse()) {
			if (target.has(relativePath) && (!source.has(relativePath) || source.get(relativePath).isDirectory() !== target.get(relativePath).isDirectory())) {
				fs.rmSync(path.join(targetRoot, relativePath), { recursive: true });
			}
		}
		for (const relativePath of changed) {
			const stat = source.get(relativePath);
			if (!stat) continue;
			const targetPath = path.join(targetRoot, relativePath);
			if (stat.isDirectory()) {
				fs.mkdirSync(targetPath, { recursive: true });
			} else {
				fs.copyFileSync(path.join(sourceRoot, relativePath), targetPath);
				fs.chmodSync(targetPath, stat.mode & 0o777);
			}
		}
	}
	console.log(changed.length === 0 ? 'Package copies match.' : `${changed.length} package entries ${args.includes('--check') ? 'differ. Run npm run sync:package.' : 'synced.'}`);
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
