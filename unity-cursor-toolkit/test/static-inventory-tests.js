// Exercise the real collector with user/package assemblies and metadata that must not execute.
// Requires the existing optional .NET 8 SDK proof boundary; not part of default npm validation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uct-static-inventory-'));
const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>';
try {
	for (const directory of ['User', 'Package', 'Runner']) fs.mkdirSync(path.join(fixture, directory));
	fs.writeFileSync(path.join(fixture, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
	for (const directory of ['User', 'Package']) fs.writeFileSync(path.join(fixture, directory, directory + '.csproj'), project);
	fs.writeFileSync(path.join(fixture, 'Package/Package.cs'), 'public class PackageState { public static int mustBeExcluded; }');
	fs.writeFileSync(path.join(fixture, 'User/User.cs'), String.raw`
using System;
namespace Unity.Scripting.LifecycleManagement {
	[AttributeUsage(AttributeTargets.Field | AttributeTargets.Class)]
	public class AutoStaticsCleanupAttribute : Attribute { public AutoStaticsCleanupAttribute() { throw new Exception("Attribute constructor ran"); } }
	[AttributeUsage(AttributeTargets.Field)]
	public class AutoStaticsCleanupOnCodeReloadAttribute : Attribute { public AutoStaticsCleanupOnCodeReloadAttribute() { throw new Exception("Attribute constructor ran"); } }
	[AttributeUsage(AttributeTargets.Field)]
	public class NoAutoStaticsCleanupAttribute : Attribute { }
}
public class Dangerous {
	static Dangerous() { throw new Exception("User static initializer ran"); }
	public static int plain;
	[Unity.Scripting.LifecycleManagement.AutoStaticsCleanup] public static int marked;
	[Unity.Scripting.LifecycleManagement.AutoStaticsCleanupOnCodeReload] public static int codeReload;
}
[Unity.Scripting.LifecycleManagement.AutoStaticsCleanup]
public class Marked {
	public static int covered;
	[Unity.Scripting.LifecycleManagement.NoAutoStaticsCleanup] public static int excluded;
}
public class Sentinel { public static int value = 42; }
` + Array.from({ length: 2300 }, (_, index) => 'public class Extra' + index + ' { public static int value; }').join('\n'));
	for (const file of ['MCP/StaticInventoryTool.cs', 'Core/AssemblyEnumerator.cs']) {
		fs.copyFileSync(path.join(root, 'Packages/com.rankupgames.unity-cursor-toolkit/Editor', file), path.join(fixture, 'Runner', path.basename(file)));
	}
	fs.writeFileSync(path.join(fixture, 'Runner/Runner.csproj'), project.replace('</PropertyGroup>', '<OutputType>Exe</OutputType><DefineConstants>UNITY_EDITOR</DefineConstants></PropertyGroup>')
		.replace('</Project>', '<ItemGroup><ProjectReference Include="../User/User.csproj"/><ProjectReference Include="../Package/Package.csproj"/></ItemGroup></Project>'));
	fs.writeFileSync(path.join(fixture, 'Runner/Probe.cs'), String.raw`
using System;
using System.Linq;
using UnityCursorToolkit.MCP;
namespace UnityEngine {
	public static class Application { public static string dataPath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "InventoryProject", "Assets"); }
	public static class JsonUtility { public static string ToJson(object value) => System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions { IncludeFields = true }); }
}
namespace UnityEditor.Compilation {
	public enum AssembliesType { Editor }
	public class Assembly { public string name; public string[] sourceFiles; }
	public static class CompilationPipeline {
		public static Assembly[] GetAssemblies(AssembliesType value) => new[] {
			new Assembly { name = typeof(Dangerous).Assembly.GetName().Name, sourceFiles = new[] { "Assets/User.cs" } },
			new Assembly { name = typeof(PackageState).Assembly.GetName().Name, sourceFiles = new[] { "Packages/example/Package.cs" } },
			new Assembly { name = typeof(Probe).Assembly.GetName().Name, sourceFiles = new[] { "Packages/toolkit/Inventory.cs" } }
		};
	}
}
namespace UnityCursorToolkit.MCP {
	[AttributeUsage(AttributeTargets.Class)] public class MCPToolAttribute : Attribute { public MCPToolAttribute(string name) {} }
	public interface IToolHandler { string ToolName { get; } string Description { get; } string HandleCommand(string json); }
	public static class GameCommandToolJson { public static string GetString(string json, string key, string fallback) => System.Text.Json.JsonDocument.Parse(json).RootElement.GetProperty(key).GetString(); }
}
public static class Probe {
	public static void Main() {
		if (Sentinel.value != 42) throw new Exception("Invalid sentinel");
		var tool = new StaticInventoryTool();
		string json = tool.HandleCommand("{\"action\":\"scan\"}");
		var payload = System.Text.Json.JsonDocument.Parse(json).RootElement.GetProperty("staticsInventory");
		var fields = payload.GetProperty("fields").EnumerateArray().ToArray();
		if (fields.Length == 0 || fields.Any(field => field.GetProperty("assembly").GetString() != "User")) throw new Exception("User/package ownership was incorrect");
		foreach (var entry in new[] { ("Dangerous", "plain", false), ("Dangerous", "marked", true), ("Dangerous", "codeReload", true), ("Marked", "covered", true), ("Marked", "excluded", false) }) {
			var field = fields.Single(field => field.GetProperty("type").GetString() == entry.Item1 && field.GetProperty("field").GetString() == entry.Item2);
			if (field.GetProperty("fieldType").GetString() != "System.Int32" || field.GetProperty("hasCleanupAttribute").GetBoolean() != entry.Item3) throw new Exception("Wrong field metadata");
		}
		if (!payload.GetProperty("truncated").GetBoolean() || payload.GetProperty("typesScanned").GetInt32() > 2048 || fields.Length > 4096) throw new Exception("Inventory limits were ignored");
		if (payload.GetProperty("errors").GetArrayLength() != 0 || Sentinel.value != 42) throw new Exception("Inventory executed or changed user state");
		string invalid = tool.HandleCommand("{\"action\":\"report\"}");
		if (!invalid.Contains("INVALID_ACTION")) throw new Exception("Unsupported bridge action was accepted");
		Console.WriteLine("User assembly metadata, cleanup flags, bounded traversal, no user execution, and typed invalid action passed.");
	}
}
`);
	const result = spawnSync('dotnet', ['run', '--project', 'Runner/Runner.csproj', '--configuration', 'Release'], {
		cwd: fixture, encoding: 'utf8', timeout: 60000,
		env: { ...process.env, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }
	});
	if (result.error) throw result.error;
	assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	console.log(result.stdout.trim());
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
