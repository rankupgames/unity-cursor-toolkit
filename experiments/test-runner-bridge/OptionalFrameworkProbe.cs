using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;

// Owned disposable compile proof. Does not execute or cancel a test job.
[InitializeOnLoad]
internal static class OptionalFrameworkProbe
{
	[Serializable] private sealed class Observation
	{
		public int pid;
		public string editorVersion;
		public string coreLibrary;
		public bool isMono;
		public bool frameworkPresent;
		public bool childPresent;
		public string childObservation;
		public string error;
	}
	static OptionalFrameworkProbe()
	{
		EditorApplication.quitting += () => File.WriteAllText(Path.Combine(ProofDirectory(), "quitting"), "normal");
	}
	private static string ProofDirectory()
	{
		string directory = Environment.GetEnvironmentVariable("UCT_TEST_COMPILE_PROOF");
		if (string.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory))
			throw new InvalidOperationException("Owned absolute proof directory required.");
		return directory;
	}
	public static void Run()
	{
		var result = new Observation
		{
			pid = Process.GetCurrentProcess().Id,
			editorVersion = Application.unityVersion,
			coreLibrary = typeof(object).Assembly.GetName().Name,
			isMono = typeof(object).Assembly.GetType("Mono.Runtime") != null
		};
		try
		{
			Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
			result.frameworkPresent = assemblies.Any(a => a.GetName().Name == "UnityEditor.TestRunner");
			Assembly child = assemblies.SingleOrDefault(a => a.GetName().Name == "UCT.OptionalFrameworkCompile.Editor");
			result.childPresent = child != null;
			if (child != null)
			{
				Type type = child.GetType("OptionalFrameworkChild", true);
				MethodInfo method = type.GetMethod("Inspect", BindingFlags.Static | BindingFlags.NonPublic);
				if (method == null) throw new MissingMethodException(type.FullName, "Inspect");
				result.childObservation = (string)method.Invoke(null, null);
			}
		}
		catch (Exception error) { result.error = error.ToString(); }
		File.WriteAllText(Path.Combine(ProofDirectory(), "compile.json"), JsonUtility.ToJson(result, true));
		if (!string.IsNullOrEmpty(result.error)) throw new InvalidOperationException(result.error);
	}
}
