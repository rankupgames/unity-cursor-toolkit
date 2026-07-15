// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit -- Experiment E1
// Description: Loads Unity's installed managed assemblies (UnityEngine.*,
//              UnityEditor.*) into a plain .NET 8 host and records, probe by
//              probe, exactly where execution dies outside the editor binary.
//              Evidence collector for docs/UNITY_WITHOUT_EDITOR_EXPERIMENTS.md.
//              Reflection-only inspection on a licensed install; no license
//              code is touched, patched, or bypassed.
//
// Usage: dotnet run -- [--unity-app /Applications/Unity/Hub/Editor/<ver>/Unity.app]
//                      [--out report.json] [--skip-risky]
//
// The report is rewritten BEFORE each risky probe so a hard native crash still
// leaves evidence of which probe was running ("status":"attempting").
// =============================================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

namespace UnityCursorToolkit.Experiments
{
	internal sealed class ProbeResult
	{
		public string name { get; set; }
		public string status { get; set; } // pass | fail | info | skipped | attempting
		public string detail { get; set; }
		public string exceptionType { get; set; }
		public string exceptionMessage { get; set; }
	}

	internal sealed class ProbeReport
	{
		public string timestampUtc { get; set; }
		public string dotnetVersion { get; set; }
		public string unityApp { get; set; }
		public List<string> managedDirs { get; set; } = new List<string>();
		public List<ProbeResult> probes { get; set; } = new List<ProbeResult>();
		public string verdict { get; set; }
	}

	internal static class Program
	{
		private static string reportPath;
		private static readonly ProbeReport report = new ProbeReport();

		private static int Main(string[] args)
		{
			report.timestampUtc = DateTime.UtcNow.ToString("o");
			report.dotnetVersion = Environment.Version.ToString();
			reportPath = GetArg(args, "--out", Path.Combine(AppContext.BaseDirectory, "report.json"));
			bool skipRisky = args.Contains("--skip-risky");

			string unityApp = ResolveUnityApp(GetArg(args, "--unity-app", null));
			report.unityApp = unityApp ?? "(not found)";
			if (unityApp == null)
			{
				AddResult("locateUnity", "fail", "Unity installation not found. Pass --unity-app or set UNITY_CURSOR_TOOLKIT_UNITY_PATH.", null);
				return Finish(1);
			}

			List<string> managedDirs = FindManagedDirs(unityApp);
			report.managedDirs = managedDirs;
			if (managedDirs.Count == 0)
			{
				AddResult("locateManaged", "fail", "No Managed assembly directories found under: " + unityApp, null);
				return Finish(1);
			}

			AssemblyLoadContext context = CreateLoadContext(managedDirs);

			// P1: load engine core module, enumerate types.
			Assembly engineCore = Probe("loadUnityEngineCore", () =>
			{
				Assembly assembly = LoadByName(context, managedDirs, "UnityEngine.CoreModule.dll", "UnityEngine.dll");
				int typeCount = SafeGetTypes(assembly).Length;
				return Tuple.Create(assembly, (object) ("Loaded " + assembly.GetName().Name + " with " + typeCount + " types."));
			});

			// P2: load editor assembly, confirm window/streaming types exist in metadata.
			Assembly editorCore = Probe("loadUnityEditorCore", () =>
			{
				Assembly assembly = LoadByName(context, managedDirs, "UnityEditor.CoreModule.dll", "UnityEditor.dll");
				Type[] types = SafeGetTypes(assembly);
				string[] wanted = { "UnityEditor.SceneView", "UnityEditor.EditorWindow", "UnityEditor.GUIView", "UnityEditor.InspectorWindow" };
				List<string> found = new List<string>();
				foreach (string name in wanted)
				{
					Type type = types.FirstOrDefault(t => t != null && t.FullName == name);
					if (type != null)
					{
						bool hasGrabPixels = name == "UnityEditor.GUIView" && type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Any(m => m.Name == "GrabPixels");
						found.Add(name + (hasGrabPixels ? " (GrabPixels present in metadata)" : string.Empty));
					}
				}
				return Tuple.Create(assembly, (object) ("Loaded " + assembly.GetName().Name + "; " + types.Length + " types; found: " + string.Join(", ", found)));
			});

			// P3: icall density -- quantify how much of the wrapper is native-bound.
			if (engineCore != null)
			{
				Probe("icallDensity", () =>
				{
					int sampled = 0;
					int internalCalls = 0;
					foreach (Type type in SafeGetTypes(engineCore).Where(t => t != null && t.IsPublic).Take(400))
					{
						foreach (MethodInfo method in type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
						{
							sampled++;
							if ((method.GetMethodImplementationFlags() & MethodImplAttributes.InternalCall) != 0)
							{
								internalCalls++;
							}
						}
					}
					return Tuple.Create((Assembly) null, (object) (internalCalls + " of " + sampled + " sampled public methods are [InternalCall] (engine-bound)."));
				});
			}

			// P4: pure managed code SHOULD run (Vector3 math has no native dependency).
			if (engineCore != null)
			{
				Probe("managedOnlyVector3", () =>
				{
					Type vector3 = engineCore.GetType("UnityEngine.Vector3", true);
					object a = Activator.CreateInstance(vector3);
					vector3.GetField("x").SetValue(a, 1f);
					object b = Activator.CreateInstance(vector3);
					vector3.GetField("x").SetValue(b, 2f);
					MethodInfo dotMethod = vector3.GetMethods(BindingFlags.Public | BindingFlags.Static)
						.First(m => m.Name == "Dot"
							&& m.ReturnType == typeof(float)
							&& m.GetParameters().Length == 2
							&& m.GetParameters()[0].ParameterType == vector3
							&& m.GetParameters()[1].ParameterType == vector3);
					object dot = dotMethod.Invoke(null, new[] { a, b });
					return Tuple.Create((Assembly) null, (object) ("Vector3.Dot executed in-host, result=" + dot + " -- pure managed code runs fine."));
				});
			}

			// P5/P6: engine-bound calls SHOULD fail -- the heart of the experiment.
			if (skipRisky)
			{
				AddResult("engineIcallApplicationVersion", "skipped", "--skip-risky", null);
				AddResult("instantiateSceneView", "skipped", "--skip-risky", null);
			}
			else
			{
				if (engineCore != null)
				{
					ProbeExpectFailure("engineIcallApplicationVersion", () =>
					{
						Type application = engineCore.GetType("UnityEngine.Application", true);
						object version = application.GetProperty("unityVersion", BindingFlags.Public | BindingFlags.Static).GetValue(null);
						return "UNEXPECTED: icall returned '" + version + "' outside the editor binary.";
					});
				}

				if (editorCore != null)
				{
					ProbeExpectFailure("instantiateSceneView", () =>
					{
						Type sceneView = editorCore.GetType("UnityEditor.SceneView", true);
						object instance = Activator.CreateInstance(sceneView, true);
						return "UNEXPECTED: SceneView instantiated outside the editor: " + instance;
					});
				}
			}

			report.verdict = BuildVerdict();
			return Finish(0);
		}

		// ---------------------------------------------------------------- core

		private static Assembly Probe(string name, Func<Tuple<Assembly, object>> action)
		{
			MarkAttempting(name);
			try
			{
				Tuple<Assembly, object> result = action();
				ReplaceResult(name, "pass", Convert.ToString(result.Item2), null);
				return result.Item1;
			}
			catch (Exception ex)
			{
				Exception root = Unwrap(ex);
				ReplaceResult(name, "fail", null, root);
				return null;
			}
		}

		private static void ProbeExpectFailure(string name, Func<string> action)
		{
			MarkAttempting(name);
			try
			{
				string unexpected = action();
				// Reaching here means the engine call worked WITHOUT the editor -- not expected.
				ReplaceResult(name, "fail", unexpected, null);
			}
			catch (Exception ex)
			{
				Exception root = Unwrap(ex);
				ReplaceResult(name, "pass", "Failed as predicted -- engine-bound member cannot execute outside the editor binary.", root);
			}
		}

		private static string BuildVerdict()
		{
			bool managedRan = report.probes.Any(p => p.name == "managedOnlyVector3" && p.status == "pass");
			bool icallDied = report.probes.Any(p => (p.name == "engineIcallApplicationVersion" || p.name == "instantiateSceneView") && p.status == "pass");
			if (managedRan && icallDied)
			{
				return "CONFIRMED: Unity's managed assemblies are wrappers; engine internal calls are only bound inside the official editor binary. "
					+ "DLL mounting is NOT a viable editor-rendering lane. Use hidden-editor (plan M3) or the player Viewport Service (E3).";
			}

			if (report.probes.Any(p => p.status == "attempting"))
			{
				return "INCONCLUSIVE: process likely crashed during the probe marked 'attempting' -- a hard native crash is itself evidence of icall unavailability.";
			}

			return "REVIEW: unexpected combination -- read individual probe results.";
		}

		// ------------------------------------------------------------- helpers

		private static AssemblyLoadContext CreateLoadContext(List<string> managedDirs)
		{
			AssemblyLoadContext context = new AssemblyLoadContext("uct-unity-probe", true);
			context.Resolving += (loadContext, assemblyName) =>
			{
				foreach (string dir in managedDirs)
				{
					string candidate = Path.Combine(dir, assemblyName.Name + ".dll");
					if (File.Exists(candidate))
					{
						return loadContext.LoadFromAssemblyPath(candidate);
					}
				}
				return null;
			};
			return context;
		}

		private static Assembly LoadByName(AssemblyLoadContext context, List<string> managedDirs, params string[] fileNames)
		{
			foreach (string dir in managedDirs)
			{
				foreach (string fileName in fileNames)
				{
					string candidate = Path.Combine(dir, fileName);
					if (File.Exists(candidate))
					{
						return context.LoadFromAssemblyPath(candidate);
					}
				}
			}

			throw new FileNotFoundException("None of [" + string.Join(", ", fileNames) + "] found under managed dirs.");
		}

		private static Type[] SafeGetTypes(Assembly assembly)
		{
			try
			{
				return assembly.GetTypes();
			}
			catch (ReflectionTypeLoadException ex)
			{
				return ex.Types.Where(t => t != null).ToArray();
			}
		}

		private static string ResolveUnityApp(string fromArg)
		{
			List<string> candidates = new List<string>();
			if (string.IsNullOrEmpty(fromArg) == false)
			{
				candidates.Add(fromArg);
			}

			string env = Environment.GetEnvironmentVariable("UNITY_CURSOR_TOOLKIT_UNITY_PATH");
			if (string.IsNullOrEmpty(env) == false)
			{
				// Env points at .../Unity.app/Contents/MacOS/Unity (or Editor\Unity.exe) -- walk up to the install root.
				DirectoryInfo dir = new DirectoryInfo(Path.GetDirectoryName(env));
				while (dir != null)
				{
					if (dir.Name.EndsWith("Unity.app", StringComparison.OrdinalIgnoreCase) || File.Exists(Path.Combine(dir.FullName, "Unity.exe")))
					{
						candidates.Add(dir.FullName);
						break;
					}
					dir = dir.Parent;
				}
			}

			string projectVersion = FindProjectVersion();
			if (projectVersion != null)
			{
				candidates.Add("/Applications/Unity/Hub/Editor/" + projectVersion + "/Unity.app");
				candidates.Add("C:\\Program Files\\Unity\\Hub\\Editor\\" + projectVersion + "\\Editor");
			}

			return candidates.FirstOrDefault(c => string.IsNullOrEmpty(c) == false && (Directory.Exists(c) || File.Exists(c)));
		}

		private static string FindProjectVersion()
		{
			try
			{
				DirectoryInfo dir = new DirectoryInfo(AppContext.BaseDirectory);
				while (dir != null)
				{
					string candidate = Path.Combine(dir.FullName, "CursorUnityTool", "ProjectSettings", "ProjectVersion.txt");
					if (File.Exists(candidate))
					{
						string line = File.ReadAllLines(candidate).FirstOrDefault(l => l.StartsWith("m_EditorVersion:"));
						return line == null ? null : line.Substring("m_EditorVersion:".Length).Trim();
					}
					dir = dir.Parent;
				}
			}
			catch (Exception)
			{
				// best effort
			}

			return null;
		}

		private static List<string> FindManagedDirs(string unityApp)
		{
			List<string> roots = new List<string>
			{
				Path.Combine(unityApp, "Contents", "Managed"),               // macOS
				Path.Combine(unityApp, "Contents", "Resources", "Scripting", "Managed"),
				Path.Combine(unityApp, "Contents", "Resources", "Scripting", "Managed", "UnityEngine"),
				Path.Combine(unityApp, "Data", "Managed"),                    // Windows/Linux
				Path.Combine(unityApp, "Data", "Resources", "Scripting", "Managed"),
				Path.Combine(unityApp, "Data", "Resources", "Scripting", "Managed", "UnityEngine"),
				Path.Combine(unityApp, "Editor", "Data", "Managed"),
				Path.Combine(unityApp, "Editor", "Data", "Resources", "Scripting", "Managed"),
				Path.Combine(unityApp, "Editor", "Data", "Resources", "Scripting", "Managed", "UnityEngine")
			};

			List<string> found = new List<string>();
			foreach (string root in roots.Where(Directory.Exists))
			{
				found.Add(root);
				found.AddRange(Directory.GetDirectories(root, "*", SearchOption.AllDirectories));
			}

			return found.Where(dir => Directory.GetFiles(dir, "Unity*.dll").Length > 0).Distinct().ToList();
		}

		private static Exception Unwrap(Exception ex)
		{
			while (ex is TargetInvocationException invocation && invocation.InnerException != null)
			{
				ex = invocation.InnerException;
			}
			return ex;
		}

		private static void MarkAttempting(string name)
		{
			AddResult(name, "attempting", null, null);
		}

		private static void AddResult(string name, string status, string detail, Exception ex)
		{
			report.probes.RemoveAll(p => p.name == name);
			report.probes.Add(new ProbeResult
			{
				name = name,
				status = status,
				detail = detail,
				exceptionType = ex == null ? null : ex.GetType().FullName,
				exceptionMessage = ex == null ? null : ex.Message
			});
			WriteReport(); // crash-safe: persist before/after every probe
		}

		private static void ReplaceResult(string name, string status, string detail, Exception ex)
		{
			AddResult(name, status, detail, ex);
		}

		private static void WriteReport()
		{
			File.WriteAllText(reportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
		}

		private static int Finish(int code)
		{
			WriteReport();
			Console.WriteLine();
			Console.WriteLine("==== editor-dll-mount-probe ====");
			foreach (ProbeResult probe in report.probes)
			{
				Console.WriteLine("  [" + probe.status.ToUpperInvariant().PadRight(10) + "] " + probe.name
					+ (probe.detail == null ? string.Empty : " -- " + probe.detail)
					+ (probe.exceptionType == null ? string.Empty : " (" + probe.exceptionType + ": " + probe.exceptionMessage + ")"));
			}
			Console.WriteLine();
			Console.WriteLine("Verdict: " + (report.verdict ?? "(none)"));
			Console.WriteLine("Report:  " + reportPath);
			return code;
		}

		private static string GetArg(string[] args, string name, string fallback)
		{
			for (int index = 0; index < args.Length - 1; index++)
			{
				if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
				{
					return args[index + 1];
				}
			}
			return fallback;
		}
	}
}
