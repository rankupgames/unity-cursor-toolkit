const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '../..');
const packageRelativePath = path.join('Packages', 'com.rankupgames.unity-cursor-toolkit');
const smokePackageRelativePath = path.join('CursorUnityTool', 'Packages', 'com.rankupgames.unity-cursor-toolkit');
const vendorRelativePath = path.join('Editor', 'ThirdParty', 'Unity-Unterm');
const canonicalPackageRoot = path.join(repositoryRoot, packageRelativePath);
const smokePackageRoot = path.join(repositoryRoot, smokePackageRelativePath);
const canonicalVendorRoot = path.join(canonicalPackageRoot, vendorRelativePath);
const smokeVendorRoot = path.join(smokePackageRoot, vendorRelativePath);
const manifestFileName = 'VENDOR.json';
const expectedUpstreamBaseCommit = 'ead1391bd38532eebfb9f13f10064eddc372b769';
const expectedPackageReleaseCommit = '3d35648c564dafab2a8df9df02cc424d321446e8';
const expectedSourceCommit = 'f3f0adb3ee09e99947b830a2ce387b736d824da2';
const expectedSourceRef = 'refs/heads/feat/toolkit-icon-performance-mcp';
const expectedBuildWorkflow = 'https://github.com/rankupgames/Unity-Unterm/actions/workflows/split-upm.yml';
const expectedLicenseHash = '5eadd917298382489f3a1d97bdd2befed92564bf163b642309f31ed21aff7383';
const expectedThirdPartyNoticesHash = '35ba1713c710b059b54e9a1d9cab7d087d646fa22dfa76db060c9fd95e809464';
const expectedRoslynNoticeHash = 'f8f25b9c793067178b41d736f9aa6f9a97265d02e2677d4ca9f48fce8f994814';
const expectedPrecompiledReferences = [
	'Microsoft.CodeAnalysis.CSharp.dll',
	'Microsoft.CodeAnalysis.dll',
	'Newtonsoft.Json.dll',
	'System.Collections.Immutable.dll',
	'System.Reflection.Metadata.dll'
];
const roslynAssemblies = [
	'Microsoft.CodeAnalysis.CSharp.dll',
	'Microsoft.CodeAnalysis.dll',
	'System.Collections.Immutable.dll',
	'System.Reflection.Metadata.dll'
];

function fail(message) {
	throw new Error(`Vendored Unity-Unterm validation failed: ${message}`);
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRelativePath(rootPath, filePath) {
	return path.relative(rootPath, filePath).split(path.sep).join('/');
}

function collectFiles(rootPath) {
	if (fs.existsSync(rootPath) === false) {
		fail(`missing vendor directory ${normalizeRelativePath(repositoryRoot, rootPath)}`);
	}

	const files = [];
	const pendingDirectories = [rootPath];
	while (pendingDirectories.length > 0) {
		const directoryPath = pendingDirectories.pop();
		const entries = fs.readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const entryPath = path.join(directoryPath, entry.name);
			const relativePath = normalizeRelativePath(rootPath, entryPath);
			const entryStats = fs.lstatSync(entryPath);
			if (entryStats.isSymbolicLink()) {
				fail(`symbolic links are not allowed: ${relativePath}`);
			}

			if (entry.isDirectory()) {
				if (entry.name === 'Tests' || entry.name === 'Test') {
					fail(`upstream test directories must not be vendored: ${relativePath}`);
				}

				pendingDirectories.push(entryPath);
				continue;
			}

			if (entry.isFile() === false) {
				fail(`unsupported filesystem entry: ${relativePath}`);
			}

			if (entry.name === 'package.json' || entry.name === 'package.json.meta') {
				fail(`nested Unity package identities are not allowed: ${relativePath}`);
			}

			if (entry.name === 'Newtonsoft.Json.dll' || entry.name === 'Newtonsoft.Json.dll.meta') {
				fail(`Newtonsoft.Json must resolve from the pinned UPM dependency, not a vendored assembly: ${relativePath}`);
			}

			if (entry.name === 'Tests.meta' || entry.name === 'Test.meta') {
				fail(`upstream test metadata must not be vendored: ${relativePath}`);
			}

			if (relativePath !== manifestFileName) {
				files.push(relativePath);
			}
		}
	}

	return files.sort((left, right) => left.localeCompare(right));
}

function sha256(filePath) {
	return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validatePackageManifest(packageRoot) {
	const packageManifest = readJson(path.join(packageRoot, 'package.json'));
	if (packageManifest.unity !== '2019.4') {
		fail(`${normalizeRelativePath(repositoryRoot, packageRoot)} must preserve Unity 2019.4 compatibility`);
	}

	const newtonsoftVersion = packageManifest.dependencies && packageManifest.dependencies['com.unity.nuget.newtonsoft-json'];
	if (newtonsoftVersion !== '3.2.1') {
		fail(`${normalizeRelativePath(repositoryRoot, packageRoot)} must pin com.unity.nuget.newtonsoft-json to 3.2.1`);
	}

	const thirdPartyNoticesPath = path.join(packageRoot, 'Third Party Notices.md');
	if (fs.existsSync(thirdPartyNoticesPath) === false) {
		fail(`${normalizeRelativePath(repositoryRoot, packageRoot)} is missing Third Party Notices.md`);
	}
	if (sha256(thirdPartyNoticesPath) !== expectedThirdPartyNoticesHash) {
		fail(`${normalizeRelativePath(repositoryRoot, thirdPartyNoticesPath)} does not match the reviewed fork notices`);
	}
}

function validateRoslynPluginMetas(vendorRoot) {
	for (const assemblyName of roslynAssemblies) {
		const relativeMetaPath = path.join('Plugins', 'Roslyn', `${assemblyName}.meta`);
		const metaPath = path.join(vendorRoot, relativeMetaPath);
		if (fs.existsSync(metaPath) === false) {
			fail(`missing explicit Roslyn importer metadata: ${normalizeRelativePath(repositoryRoot, metaPath)}`);
		}

		const metaText = fs.readFileSync(metaPath, 'utf8');
		if (metaText.includes('isExplicitlyReferenced: 1') === false || metaText.includes('Editor: Editor') === false || /Any:[\s\S]{0,240}enabled: 0/.test(metaText) === false) {
			fail(`${normalizeRelativePath(repositoryRoot, metaPath)} must be Editor-only and explicitly referenced`);
		}
	}
}

function validateNativePluginMeta(vendorRoot, relativePath, expectedGuid, expectedOs, expectedCpu) {
	const metaPath = path.join(vendorRoot, `${relativePath}.meta`);
	if (fs.existsSync(metaPath) === false) {
		fail(`missing native plugin metadata: ${normalizeRelativePath(repositoryRoot, metaPath)}`);
	}

	const metaText = fs.readFileSync(metaPath, 'utf8');
	const editorImporterPattern = new RegExp(`Editor: Editor[\\s\\S]{0,220}enabled: 1[\\s\\S]{0,220}CPU: ${expectedCpu}[\\s\\S]{0,220}OS: ${expectedOs}`);
	if (metaText.includes(`guid: ${expectedGuid}`) === false || metaText.includes('PluginImporter:') === false || /:\sAny[\s\S]{0,220}enabled: 0/.test(metaText) === false || editorImporterPattern.test(metaText) === false) {
		fail(`${normalizeRelativePath(repositoryRoot, metaPath)} must preserve the reviewed Editor-only ${expectedOs} importer`);
	}
}

function validateVendorManifest(vendorRoot) {
	const vendorManifestPath = path.join(vendorRoot, manifestFileName);
	if (fs.existsSync(vendorManifestPath) === false) {
		fail(`missing ${normalizeRelativePath(repositoryRoot, vendorManifestPath)}`);
	}

	const vendorManifest = readJson(vendorManifestPath);
	if (vendorManifest.schemaVersion !== 1 || vendorManifest.name !== 'Unity-Unterm' || vendorManifest.license !== 'MIT') {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} has invalid identity metadata`);
	}

	if (vendorManifest.sourceRepository !== 'https://github.com/rankupgames/Unity-Unterm' || vendorManifest.upstreamRepository !== 'https://github.com/tnayuki/Unity-Unterm') {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} has unexpected source repositories`);
	}

	if (vendorManifest.sourceCommit !== expectedSourceCommit) {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} must pin the reviewed fork commit`);
	}

	if (vendorManifest.sourceRef !== expectedSourceRef) {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} has an unexpected attested source ref`);
	}

	if (vendorManifest.build === null || typeof vendorManifest.build !== 'object' || typeof vendorManifest.build.workflow !== 'string' || typeof vendorManifest.build.run !== 'string' || typeof vendorManifest.build.attestation !== 'string') {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} must pin the fork build workflow, run, and attestation`);
	}

	if (vendorManifest.build.workflow !== expectedBuildWorkflow || vendorManifest.build.run.startsWith('https://github.com/rankupgames/Unity-Unterm/actions/runs/') === false || vendorManifest.build.attestation.startsWith('https://github.com/rankupgames/Unity-Unterm/attestations/') === false) {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} has invalid fork provenance URLs`);
	}

	if (vendorManifest.upstreamBaseCommit !== expectedUpstreamBaseCommit || vendorManifest.packageReleaseCommit !== expectedPackageReleaseCommit || vendorManifest.minimumUnity !== '6000.3') {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} has unexpected audited release metadata`);
	}

	if (vendorManifest.files === null || typeof vendorManifest.files !== 'object' || Array.isArray(vendorManifest.files)) {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} must contain a files checksum map`);
	}

	const actualFiles = collectFiles(vendorRoot);
	const manifestFiles = Object.keys(vendorManifest.files);
	const sortedManifestFiles = [...manifestFiles].sort((left, right) => left.localeCompare(right));
	if (JSON.stringify(manifestFiles) !== JSON.stringify(sortedManifestFiles)) {
		fail(`${normalizeRelativePath(repositoryRoot, vendorManifestPath)} file keys must be sorted`);
	}

	if (JSON.stringify(actualFiles) !== JSON.stringify(sortedManifestFiles)) {
		const missingFiles = sortedManifestFiles.filter(relativePath => actualFiles.includes(relativePath) === false);
		const untrackedFiles = actualFiles.filter(relativePath => sortedManifestFiles.includes(relativePath) === false);
		fail(`vendor manifest mismatch; missing=[${missingFiles.join(', ')}], untracked=[${untrackedFiles.join(', ')}]`);
	}

	for (const relativePath of sortedManifestFiles) {
		const expectedHash = vendorManifest.files[relativePath];
		if (typeof expectedHash !== 'string' || /^[a-f0-9]{64}$/.test(expectedHash) === false) {
			fail(`invalid SHA-256 for ${relativePath}`);
		}

		const actualHash = sha256(path.join(vendorRoot, relativePath));
		if (actualHash !== expectedHash) {
			fail(`checksum mismatch for ${relativePath}`);
		}
	}

	const trustedLegalHashes = {
		'LICENSE.md': expectedLicenseHash,
		'Third Party Notices.md': expectedThirdPartyNoticesHash,
		'Plugins/Roslyn/THIRD-PARTY-NOTICE.md': expectedRoslynNoticeHash
	};
	for (const [relativePath, expectedHash] of Object.entries(trustedLegalHashes)) {
		if (vendorManifest.files[relativePath] !== expectedHash) {
			fail(`${relativePath} does not match the reviewed legal text`);
		}
	}

	const requiredFileChecks = [
		relativePath => relativePath === 'LICENSE.md',
		relativePath => relativePath === 'Unterm.Editor.asmdef',
		relativePath => relativePath === 'ToolkitMenuItems.cs',
		relativePath => relativePath === 'Third Party Notices.md',
		relativePath => relativePath === 'Plugins/macOS/unterm.dylib',
		relativePath => relativePath === 'Plugins/macOS/unterm-debugger',
		relativePath => relativePath === 'Plugins/Windows/x86_64/unterm.dll',
		relativePath => relativePath === 'Plugins/Windows/x86_64/unterm-debugger.exe'
	];
	for (const requiredFileCheck of requiredFileChecks) {
		if (sortedManifestFiles.some(requiredFileCheck) === false) {
			fail(`${normalizeRelativePath(repositoryRoot, vendorRoot)} is missing a required source, notice, or plugin file`);
		}
	}

	const macDebuggerPath = path.join(vendorRoot, 'Plugins', 'macOS', 'unterm-debugger');
	if ((fs.statSync(macDebuggerPath).mode & 0o111) === 0) {
		fail(`${normalizeRelativePath(repositoryRoot, macDebuggerPath)} must retain executable permissions`);
	}

	const asmdef = readJson(path.join(vendorRoot, 'Unterm.Editor.asmdef'));
	if (asmdef.name !== 'UnityCursorToolkit.Vendor.Unterm.Editor' || asmdef.rootNamespace !== 'Unterm.Editor') {
		fail('Unterm.Editor.asmdef must use the toolkit-owned vendor assembly identity');
	}

	if (Array.isArray(asmdef.includePlatforms) === false || asmdef.includePlatforms.includes('Editor') === false) {
		fail('Unterm.Editor.asmdef must remain Editor-only');
	}

	const expectedDefineConstraints = ['UNITY_6000_3_OR_NEWER', 'UNITY_EDITOR_OSX || UNITY_EDITOR_WIN'];
	if (JSON.stringify(asmdef.defineConstraints) !== JSON.stringify(expectedDefineConstraints)) {
		fail('Unterm.Editor.asmdef must be constrained to Unity 6000.3 and macOS or Windows Editors');
	}

	const actualPrecompiledReferences = Array.isArray(asmdef.precompiledReferences) ? [...asmdef.precompiledReferences].sort((left, right) => left.localeCompare(right)) : [];
	const sortedExpectedPrecompiledReferences = [...expectedPrecompiledReferences].sort((left, right) => left.localeCompare(right));
	if (asmdef.overrideReferences !== true || JSON.stringify(actualPrecompiledReferences) !== JSON.stringify(sortedExpectedPrecompiledReferences)) {
		fail('Unterm.Editor.asmdef must explicitly reference the reviewed managed plugin set');
	}

	validateRoslynPluginMetas(vendorRoot);
	validateNativePluginMeta(vendorRoot, 'Plugins/macOS/unterm.dylib', '54ea61c3e6ad54b688596fae0846fc88', 'OSX', 'AnyCPU');
	validateNativePluginMeta(vendorRoot, 'Plugins/Windows/x86_64/unterm.dll', '3c18e287bcb84b3ba7fc203c80c79bf3', 'Windows', 'x86_64');

	return vendorManifest;
}

function validateMirroredVendor(canonicalManifest) {
	const smokeManifest = validateVendorManifest(smokeVendorRoot);
	if (JSON.stringify(smokeManifest) !== JSON.stringify(canonicalManifest)) {
		fail('canonical and internal smoke VENDOR.json files differ');
	}

	const canonicalFiles = [manifestFileName, ...Object.keys(canonicalManifest.files)];
	for (const relativePath of canonicalFiles) {
		const canonicalHash = sha256(path.join(canonicalVendorRoot, relativePath));
		const smokeHash = sha256(path.join(smokeVendorRoot, relativePath));
		if (canonicalHash !== smokeHash) {
			fail(`canonical and internal smoke vendor copies differ at ${relativePath}`);
		}
	}

	const packageLevelFiles = [
		path.join('Editor', 'ThirdParty.meta'),
		path.join('Editor', 'ThirdParty', 'Unity-Unterm.meta'),
		'Third Party Notices.md',
		'Third Party Notices.md.meta'
	];
	for (const relativePath of packageLevelFiles) {
		const canonicalPath = path.join(canonicalPackageRoot, relativePath);
		const smokePath = path.join(smokePackageRoot, relativePath);
		if (fs.existsSync(canonicalPath) === false || fs.existsSync(smokePath) === false || sha256(canonicalPath) !== sha256(smokePath)) {
			fail(`canonical and internal smoke package metadata differ at ${relativePath}`);
		}
	}
}

validatePackageManifest(canonicalPackageRoot);
validatePackageManifest(smokePackageRoot);
const canonicalManifest = validateVendorManifest(canonicalVendorRoot);
validateMirroredVendor(canonicalManifest);
console.log(`Validated ${Object.keys(canonicalManifest.files).length} vendored Unity-Unterm files at ${canonicalManifest.sourceCommit}`);
