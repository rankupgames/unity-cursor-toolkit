using System;
using System.IO;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

[InitializeOnLoad]
internal static partial class FrameworkObserver
{
	private static readonly string DirectoryPath = Environment.GetEnvironmentVariable("UCT_TEST_BRIDGE_PROOF");
	private static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
	private static TestRunnerApi _api;
	private static Callbacks _callbacks;
	private static bool _quitting;
	static FrameworkObserver()
	{
#if !UNITY_7000_0_OR_NEWER
		Initialize();
#endif
	}
#if UNITY_7000_0_OR_NEWER
	[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
#endif
	private static void Initialize()
	{
		if (_api != null || _quitting) return;
		if (string.IsNullOrEmpty(DirectoryPath) || !File.Exists(Path.Combine(DirectoryPath, "owner"))
			|| File.ReadAllText(Path.Combine(DirectoryPath, "owner")) != Pid.ToString()) return;
		_api = ScriptableObject.CreateInstance<TestRunnerApi>(); _callbacks = new Callbacks();
		_api.RegisterCallbacks(_callbacks);
		#if !UNITY_7000_0_OR_NEWER
		AssemblyReloadEvents.beforeAssemblyReload += Unload;
#endif
		EditorApplication.quitting += Quit;
		Record("observerRegistered", "", JsonUtility.ToJson(new NullShape()));
	}
	private static void Quit() { _quitting = true; Cleanup(); }
#if UNITY_7000_0_OR_NEWER
	[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
#endif
	private static void Unload() { if (!_quitting) Cleanup(); }
	private static void Cleanup()
	{
		Record("observerCleanup", "", "");
		#if !UNITY_7000_0_OR_NEWER
		AssemblyReloadEvents.beforeAssemblyReload -= Unload;
#endif
		EditorApplication.quitting -= Quit;
		if (_api != null) { _api.UnregisterCallbacks(_callbacks); UnityEngine.Object.DestroyImmediate(_api); _api = null; }
	}
	private static void Record(string callback, string fullName, string detail)
	{
		File.AppendAllText(Path.Combine(DirectoryPath, "framework-events.jsonl"),
			JsonUtility.ToJson(new Event { at = DateTime.UtcNow.ToString("O"), callback = callback, fullName = fullName, detail = detail }) + "\n");
	}
	private sealed class Callbacks : ICallbacks
	{
		public void RunStarted(ITestAdaptor root) { Record("runStarted", root.FullName, root.TestMode.ToString()); }
		public void RunFinished(ITestResultAdaptor result) { Record("runFinished", result.FullName, result.ResultState); }
		public void TestStarted(ITestAdaptor test) { if (!test.IsSuite) Record("testStarted", test.FullName, ""); }
		public void TestFinished(ITestResultAdaptor result) { if (!result.Test.IsSuite) Record("testFinished", result.FullName, result.ResultState); }
	}
	[Serializable] private sealed class Event { public string at, callback, fullName, detail; }
	[Serializable] private sealed class NullShape { public Detail error; }
	[Serializable] private sealed class Detail { public string code, message, recovery; }
}
