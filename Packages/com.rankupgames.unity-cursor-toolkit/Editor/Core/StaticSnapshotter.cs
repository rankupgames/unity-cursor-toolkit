#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityCursorToolkit.MCP;

namespace UnityCursorToolkit.Core
{
	/// <summary>Opt-in value fingerprints. No play/reload hooks are registered here.</summary>
	internal static class StaticSnapshotter
	{
		private static bool enabled;
		private static string[] assemblyAllowlist = new string[0];
		private static int maxFields = 1000;
		private static int maxScanMilliseconds = 10;
		internal static Snapshot Latest { get; private set; }
		internal static bool Enabled => enabled;

		internal static void Configure(string json)
		{
			enabled = false;
			Latest = null;
			try
			{
				var input = JObject.Parse(json);
				if (input["enabled"]?.Type != JTokenType.Boolean) throw new InvalidOperationException();
				if (!(bool)input["enabled"]) { assemblyAllowlist = new string[0]; return; }
				var names = input["assemblyAllowlist"] as JArray;
				if (names == null || names.Count > 128 || input["maxFields"]?.Type != JTokenType.Integer
					|| input["maxScanMilliseconds"]?.Type != JTokenType.Integer) throw new InvalidOperationException();
				int fields = (int)input["maxFields"], milliseconds = (int)input["maxScanMilliseconds"];
				if (fields < 1 || fields > 1000 || milliseconds < 1 || milliseconds > 100) throw new InvalidOperationException();
				var allowlist = new HashSet<string>(StringComparer.Ordinal);
				foreach (var name in names)
				{
					if (name.Type != JTokenType.String) throw new InvalidOperationException();
					string text = (string)name;
					if (string.IsNullOrWhiteSpace(text) || text.Length > 128 || text.IndexOfAny(new[] { '/', '\\', '\r', '\n', '\0' }) >= 0) throw new InvalidOperationException();
					allowlist.Add(text);
				}
				assemblyAllowlist = new List<string>(allowlist).ToArray();
				maxFields = fields;
				maxScanMilliseconds = milliseconds;
				enabled = true;
				Capture();
			}
			catch { enabled = false; assemblyAllowlist = new string[0]; Publish(new Snapshot { skippedReason = "invalid_configuration" }); }
		}

		internal static Snapshot Capture()
		{
			if (!enabled) return null;
			var result = new Snapshot();
			var timer = Stopwatch.StartNew();
			try
			{
				if (assemblyAllowlist.Length == 0) { result.complete = true; return Finish(result, timer); }
				bool stopped;
				var owned = StaticInventoryTool.GetUserAssemblyNames(timer, maxScanMilliseconds, out stopped);
				if (stopped || Expired(timer)) return Skip(result, timer, "time_budget");
				var allowed = new HashSet<string>(assemblyAllowlist, StringComparer.Ordinal);
				foreach (var assembly in AssemblyEnumerator.GetLoaded())
				{
					if (Expired(timer)) return Skip(result, timer, "time_budget");
					string name = assembly.GetName().Name;
					if (!allowed.Contains(name) || !owned.Contains(name)) continue;
					// Unity reflection calls cannot be preempted; check the cooperative budget afterwards too.
					var types = assembly.GetTypes();
					if (Expired(timer)) return Skip(result, timer, "time_budget");
					foreach (var type in types)
					{
						if (Expired(timer)) return Skip(result, timer, "time_budget");
						var fields = type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
						if (Expired(timer)) return Skip(result, timer, "time_budget");
						foreach (var field in fields)
						{
							if (result.fields.Count >= maxFields) return Skip(result, timer, "field_cap");
							if (Expired(timer)) return Skip(result, timer, "time_budget");
							var entry = new Entry { assembly = name, type = type.FullName ?? type.Name, field = field.Name };
							if (entry.assembly.Length > 128 || entry.type.Length > 512 || entry.field.Length > 512) return Skip(result, timer, "identity_limit");
							Read(field, entry);
							if (Expired(timer)) return Skip(result, timer, "time_budget");
							result.fields.Add(entry);
							if (result.fields.Count >= maxFields) return Skip(result, timer, "field_cap");
						}
					}
				}
				result.fields.Sort((left, right) => string.CompareOrdinal(left.assembly + "/" + left.type + "/" + left.field, right.assembly + "/" + right.type + "/" + right.field));
				if (Expired(timer)) return Skip(result, timer, "time_budget");
				result.complete = true;
				return Finish(result, timer);
			}
			catch { return Skip(result, timer, "reflection_unavailable"); }
		}

		private static bool Expired(Stopwatch timer) => timer.Elapsed.TotalMilliseconds >= maxScanMilliseconds;

		private static Snapshot Skip(Snapshot result, Stopwatch timer, string reason)
		{
			result.fields.Clear();
			result.complete = false;
			result.skippedReason = reason;
			if (reason == "field_cap" || reason == "time_budget")
				UnityEngine.Debug.LogWarning("{\"command\":\"staticsWarning\",\"code\":\"" + reason + "\",\"message\":\"Static snapshot skipped at its cooperative budget.\"}");
			return Finish(result, timer);
		}

		private static Snapshot Finish(Snapshot result, Stopwatch timer)
		{
			result.durationMs = timer.Elapsed.TotalMilliseconds;
			Publish(result);
			return result;
		}

		private static void Publish(Snapshot result)
		{
			Latest = result;
			HotReloadHandler.BroadcastToClients("{\"command\":\"staticsSnapshot\",\"snapshot\":" + JsonUtility.ToJson(result) + "}");
		}

		private static void Read(FieldInfo field, Entry entry)
		{
			try
			{
				if (field.DeclaringType.ContainsGenericParameters) { entry.unreadableReason = "open_generic_type"; return; }
				// GetValue may run a user static initializer even if the field was read before.
				if (!field.IsLiteral && field.DeclaringType.TypeInitializer != null) { entry.unreadableReason = "static_initializer"; return; }
				foreach (var attribute in CustomAttributeData.GetCustomAttributes(field))
					if (attribute.AttributeType == typeof(ThreadStaticAttribute)) { entry.unreadableReason = "thread_static"; return; }
				object value = field.IsLiteral ? field.GetRawConstantValue() : field.GetValue(null);
				if (value == null) { entry.fingerprint = "null"; return; }
				Type type = value.GetType();
				byte[] bytes;
				if (type == typeof(string))
				{
					string text = (string)value;
					if (text.Length > 4096) { entry.unreadableReason = "value_too_large"; return; }
					bytes = new byte[text.Length * 2];
					for (int i = 0; i < text.Length; i++) { bytes[i * 2] = (byte)text[i]; bytes[i * 2 + 1] = (byte)(text[i] >> 8); }
				}
				else if (type.IsArray) { entry.fingerprint = "array-count:" + ((Array)value).LongLength.ToString(System.Globalization.CultureInfo.InvariantCulture); return; }
				else if (type == typeof(bool)) bytes = new[] { (byte)((bool)value ? 1 : 0) };
				else if (type == typeof(byte)) bytes = new[] { (byte)value };
				else if (type == typeof(sbyte)) bytes = new[] { unchecked((byte)(sbyte)value) };
				else if (type == typeof(char)) bytes = BitConverter.GetBytes((char)value);
				else if (type == typeof(short)) bytes = BitConverter.GetBytes((short)value);
				else if (type == typeof(ushort)) bytes = BitConverter.GetBytes((ushort)value);
				else if (type == typeof(int)) bytes = BitConverter.GetBytes((int)value);
				else if (type == typeof(uint)) bytes = BitConverter.GetBytes((uint)value);
				else if (type == typeof(long)) bytes = BitConverter.GetBytes((long)value);
				else if (type == typeof(ulong)) bytes = BitConverter.GetBytes((ulong)value);
				else if (type == typeof(float)) bytes = BitConverter.GetBytes((float)value);
				else if (type == typeof(double)) bytes = BitConverter.GetBytes((double)value);
				else { entry.unreadableReason = "unsupported_type"; return; }
				// Fixed FNV-1a over bounded scalar bytes; never call a value's virtual methods.
				ulong hash = 14695981039346656037UL;
				foreach (byte item in bytes) { hash ^= item; hash = unchecked(hash * 1099511628211UL); }
				entry.fingerprint = type.FullName + ":fnv64:" + hash.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
			}
			catch { entry.unreadableReason = "field_read_failed"; }
		}

		[Serializable]
		internal sealed class Snapshot
		{
			public bool complete;
			public string skippedReason = "";
			public double durationMs;
			public List<Entry> fields = new List<Entry>();
		}

		[Serializable]
		internal sealed class Entry
		{
			public string assembly;
			public string type;
			public string field;
			public string fingerprint = "";
			public string unreadableReason = "";
		}
	}
}

#endif
