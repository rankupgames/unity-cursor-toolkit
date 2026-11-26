using System;
using System.Reflection;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

// This file must not compile when the optional package is absent.
internal static class OptionalFrameworkChild
{
	[Serializable] private sealed class Observation
	{
		public string apiAssembly;
		public string cancelSignature;
		public bool callbacksCompiled;
		public bool typeMetadataProperty;
		public string editMode;
		public string playMode;
	}
	private sealed class Callbacks : ICallbacks
	{
		public void RunStarted(ITestAdaptor testsToRun) { }
		public void RunFinished(ITestResultAdaptor result) { }
		public void TestStarted(ITestAdaptor test) { }
		public void TestFinished(ITestResultAdaptor result) { }
	}
	internal static string Inspect()
	{
		MethodInfo cancel = typeof(TestRunnerApi).GetMethod("CancelTestRun", BindingFlags.Public | BindingFlags.Static,
			null, new[] { typeof(string) }, null);
		var callbacks = new Callbacks();
		var api = ScriptableObject.CreateInstance<TestRunnerApi>();
		api.RegisterCallbacks(callbacks);
		api.UnregisterCallbacks(callbacks);
		UnityEngine.Object.DestroyImmediate(api);
		return JsonUtility.ToJson(new Observation
		{
			apiAssembly = typeof(TestRunnerApi).Assembly.GetName().Name,
			cancelSignature = cancel != null && cancel.ReturnType == typeof(bool) ? cancel.ToString() : "",
			callbacksCompiled = true,
			typeMetadataProperty = typeof(ITestAdaptor).GetProperty("TypeInfo") != null,
			editMode = TestMode.EditMode.ToString(),
			playMode = TestMode.PlayMode.ToString()
		});
	}
}
