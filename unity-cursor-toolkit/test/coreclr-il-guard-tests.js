// Run the real C# entry point on CoreCLR. Unity stubs reject any downstream work.
// Requires an installed .NET 8 SDK. No Unity Editor or package restore is needed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const editor = path.join(root, 'Packages', 'com.rankupgames.unity-cursor-toolkit', 'Editor');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-coreclr-il-guard-'));
function run(...args) {
	const result = spawnSync('dotnet', args, { cwd: fixture, encoding: 'utf8', timeout: 60000,
		env: { ...process.env, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
	if (result.error) throw result.error;
	assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	return result;
}

try {
	for (const file of ['HotReload/ILPatcher.cs', 'Core/RuntimeCapabilities.cs', 'Core/AssemblyEnumerator.cs']) {
		fs.copyFileSync(path.join(editor, file), path.join(fixture, path.basename(file)));
	}
	fs.writeFileSync(path.join(fixture, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><DefineConstants>UNITY_EDITOR;UNITY_EDITOR_WIN</DefineConstants><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
	fs.writeFileSync(path.join(fixture, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
	fs.writeFileSync(path.join(fixture, 'Probe.cs'), String.raw`
using System;
using System.Reflection;
using UnityCursorToolkit.Core;
using UnityCursorToolkit.HotReload;
namespace UnityEngine {
	public class Object { public static T[] FindObjectsOfType<T>() => throw new Exception("Object lookup must not run."); }
	public class MonoBehaviour : Object { }
	public static class Application {
		public static string dataPath => throw new Exception("Project lookup must not run.");
		public static string temporaryCachePath => throw new Exception("Temporary file access must not run.");
	}
	public static class Debug {
		public static int Errors;
		public static void LogError(object message) { Errors++; }
		public static void LogWarning(object message) => throw new Exception("Patch work must not run.");
	}
}
namespace UnityEditor {
	public static class EditorApplication {
		public static int Accesses;
		public static bool isPlaying { get { Accesses++; throw new Exception("Editor state lookup must not run."); } }
		public static string applicationPath => throw new Exception("Compiler lookup must not run.");
	}
	public static class EditorUserBuildSettings { public static string[] activeScriptCompilationDefines => throw new Exception("Compiler defines lookup must not run."); }
	public static class AssemblyReloadEvents { public static event Action beforeAssemblyReload; }
}
namespace UnityEditor.Compilation {
	public static class CompilationPipeline {
		public static event Action<object> compilationFinished;
		public static string GetAssemblyNameFromScriptPath(string path) => throw new Exception("Compiler work must not run.");
	}
}
public static class Probe {
	public static void Main() {
		if (!RuntimeCapabilities.IsCoreCLR || RuntimeCapabilities.HasDomainReload) throw new Exception("The probe must use CoreCLR.");
		if (!System.Linq.Enumerable.Contains(AssemblyEnumerator.GetLoaded(), typeof(Probe).Assembly)) throw new Exception("Enumeration omitted the probe.");
		PatchResult observed = null;
		int completed = 0, patchLoads = 0;
		ILPatcher.OnPatchCompleted += result => { observed = result; completed++; };
		AppDomain.CurrentDomain.AssemblyLoad += (sender, args) => {
			if (args.LoadedAssembly.GetName().Name.StartsWith("patch_")) patchLoads++;
		};
		foreach (string[] files in new[] { new[] { "must-not-be-read.cs" }, Array.Empty<string>(), null }) {
			PatchResult result = ILPatcher.TryPatch(files);
			if (result.Success || typeof(PatchResult).GetField("ErrorCode")?.GetValue(result)?.ToString() != "CapabilityUnavailable") throw new Exception("Missing typed capability error.");
			if (!ReferenceEquals(observed, result)) throw new Exception("The failure was not surfaced.");
			if (!result.FallbackReason.Contains("script reload")) throw new Exception("The error has no alternative.");
		}
		if (completed != 3 || UnityEngine.Debug.Errors != 3) throw new Exception("The failure was not logged and surfaced once per request.");
		if (UnityEditor.EditorApplication.Accesses != 0 || patchLoads != 0) throw new Exception("The guard performed downstream work.");
		Console.WriteLine("CoreCLR guard returned typed errors before Editor, compiler, file, and patch assembly work.");
	}
}
`);
	run('run', '--project', 'Probe.csproj', '--configuration', 'Release');
	console.log('  1 passed, 0 failed, 1 total');
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
