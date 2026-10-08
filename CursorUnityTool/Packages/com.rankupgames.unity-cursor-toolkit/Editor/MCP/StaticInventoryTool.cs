#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using UnityEditor.Compilation;
using UnityEngine;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("coreclr_migration")]
	internal sealed class StaticInventoryTool : IToolHandler
	{
		public string ToolName => "coreclr_migration";
		public string Description => "Read loaded user static field metadata without reading or changing values.";

		public string HandleCommand(string argsJson)
		{
			if (GameCommandToolJson.GetString(argsJson, "action", "") != "scan")
				return "{\"success\":false,\"errorCode\":\"INVALID_ACTION\",\"error\":\"The Unity inventory handler supports action scan.\"}";
			return JsonUtility.ToJson(new InventoryResponse {
				projectPath = Directory.GetParent(Application.dataPath).FullName,
				staticsInventory = Collect()
			});
		}

		internal static Inventory Collect()
		{
			var result = new Inventory();
			var timer = Stopwatch.StartNew();
			var userAssemblies = new HashSet<string>(StringComparer.Ordinal);
			string projectRoot = Directory.GetParent(Application.dataPath).FullName;
			string assetsRoot = Path.GetFullPath(Application.dataPath) + Path.DirectorySeparatorChar;
			var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
			foreach (var assembly in CompilationPipeline.GetAssemblies(AssembliesType.Editor))
			{
				// Source ownership, not name prefixes: package and engine assemblies are excluded.
				if (assembly.sourceFiles.Length == 0) continue;
				bool ownsAllSources = true;
				foreach (string source in assembly.sourceFiles)
				{
					if (!Path.GetFullPath(Path.IsPathRooted(source) ? source : Path.Combine(projectRoot, source)).StartsWith(assetsRoot, comparison)) { ownsAllSources = false; break; }
					if (timer.ElapsedMilliseconds >= result.maxDurationMs) { result.truncated = true; break; }
				}
				if (result.truncated) break;
				if (ownsAllSources) userAssemblies.Add(assembly.name);
			}
			foreach (var assembly in AssemblyEnumerator.GetLoaded())
			{
				if (result.truncated || timer.ElapsedMilliseconds >= result.maxDurationMs) { result.truncated = true; break; }
				if (!userAssemblies.Contains(assembly.GetName().Name)) continue;
				if (result.assembliesScanned >= result.maxAssemblies) { result.truncated = true; break; }
				result.assembliesScanned++;
				Type[] types;
				try { types = assembly.GetTypes(); }
				catch (ReflectionTypeLoadException error) {
					types = error.Types;
					result.errors.Add(assembly.GetName().Name + ": some types could not be loaded.");
				}
				catch (Exception error) { result.errors.Add(assembly.GetName().Name + ": " + error.Message); continue; }
				foreach (var type in types)
				{
					if (type == null) continue;
					if (result.typesScanned >= result.maxTypes || timer.ElapsedMilliseconds >= result.maxDurationMs) { result.truncated = true; break; }
					result.typesScanned++;
					try {
						foreach (var field in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
						{
							if (result.fields.Count >= result.maxFields || timer.ElapsedMilliseconds >= result.maxDurationMs) { result.truncated = true; break; }
							result.fields.Add(new StaticField {
								assembly = assembly.GetName().Name,
								type = type.FullName ?? type.Name,
								field = field.Name,
								fieldType = field.FieldType.FullName ?? field.FieldType.Name,
								hasCleanupAttribute = HasCleanup(field)
							});
						}
					}
					catch (Exception error) { result.errors.Add((type.FullName ?? type.Name) + ": " + error.Message); }
					if (result.truncated) break;
				}
			}
			result.fields.Sort((left, right) => string.CompareOrdinal(left.assembly + "/" + left.type + "/" + left.field,
				right.assembly + "/" + right.type + "/" + right.field));
			result.durationMs = timer.ElapsedMilliseconds;
			return result;
		}

		private static bool HasCleanup(FieldInfo field)
		{
			// CustomAttributeData inspects metadata without running user attribute constructors.
			bool cleanup = HasAttribute(field, "Unity.Scripting.LifecycleManagement.AutoStaticsCleanupAttribute")
				|| HasAttribute(field, "Unity.Scripting.LifecycleManagement.AutoStaticsCleanupOnCodeReloadAttribute")
				|| HasAttribute(field.DeclaringType, "Unity.Scripting.LifecycleManagement.AutoStaticsCleanupAttribute")
				|| HasAttribute(field.DeclaringType, "Unity.Scripting.LifecycleManagement.AutoStaticsCleanupOnCodeReloadAttribute");
			return cleanup && !HasAttribute(field, "Unity.Scripting.LifecycleManagement.NoAutoStaticsCleanupAttribute");
		}

		private static bool HasAttribute(MemberInfo member, string fullName)
		{
			foreach (var attribute in CustomAttributeData.GetCustomAttributes(member))
				if (attribute.AttributeType.FullName == fullName) return true;
			return false;
		}

		[Serializable]
		private sealed class InventoryResponse
		{
			public string projectPath;
			public Inventory staticsInventory;
		}

		[Serializable]
		internal sealed class Inventory
		{
			public List<StaticField> fields = new List<StaticField>();
			public int assembliesScanned;
			public int typesScanned;
			public bool truncated;
			public List<string> errors = new List<string>();
			public long durationMs;
			public int maxAssemblies = 128;
			public int maxTypes = 2048;
			public int maxFields = 4096;
			// Includes compilation metadata discovery; individual Unity calls cannot be preempted.
			public int maxDurationMs = 500;
		}

		[Serializable]
		internal sealed class StaticField
		{
			public string assembly;
			public string type;
			public string field;
			public string fieldType;
			public bool hasCleanupAttribute;
		}
	}
}

#endif
