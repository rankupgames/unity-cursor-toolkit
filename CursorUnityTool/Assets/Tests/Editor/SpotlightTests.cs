using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace UnityCursorToolkit.Tests
{
	// Run only in an isolated test project. These fixtures own their scenes and assets.
	[Category("Spotlight")]
	public sealed class SpotlightTests
	{
		private const BindingFlags Members = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
		private static readonly Type SearchType = Type.GetType("UnityCursorToolkit.Spotlight.SpotlightSearch, UnityCursorToolkit.Editor", true);
		private static readonly Type WindowType = Type.GetType("UnityCursorToolkit.Spotlight.SpotlightWindow, UnityCursorToolkit.Editor", true);
		private readonly List<IDisposable> sessions = new List<IDisposable>();
		private Scene firstScene, secondScene, previousScene;
		private GameObject firstObject, secondObject;
		private Component firstComponent, secondComponent;
		private Object[] previousSelection;
		private string assetFolder;
		private EditorWindow palette, owner;
		private static int commandCalls;

		[SetUp]
		public void SetUp()
		{
			previousSelection = Selection.objects;
			previousScene = SceneManager.GetActiveScene();
			firstScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
			secondScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
			firstObject = new GameObject("SpotlightFixture");
			secondObject = new GameObject("SpotlightFixture");
			SceneManager.MoveGameObjectToScene(firstObject, firstScene);
			SceneManager.MoveGameObjectToScene(secondObject, secondScene);
			secondObject.SetActive(false);
			firstComponent = firstObject.AddComponent<BoxCollider>();
			secondComponent = firstObject.AddComponent<BoxCollider>();
			assetFolder = "Assets/SpotlightFixture_" + Guid.NewGuid().ToString("N");
			AssetDatabase.CreateFolder("Assets", assetFolder.Substring("Assets/".Length));
			commandCalls = 0;
		}

		[TearDown]
		public void TearDown()
		{
			foreach (var session in sessions) session.Dispose();
			sessions.Clear();
			if (palette != null) palette.Close();
			if (owner != null) owner.Close();
			Selection.objects = previousSelection;
			if (previousScene.IsValid() && previousScene.isLoaded) SceneManager.SetActiveScene(previousScene);
			if (firstScene.IsValid() && firstScene.isLoaded) EditorSceneManager.CloseScene(firstScene, true);
			if (secondScene.IsValid() && secondScene.isLoaded) EditorSceneManager.CloseScene(secondScene, true);
			Assert.IsTrue(AssetDatabase.DeleteAsset(assetFolder), "The owned asset fixture was not removed.");
		}

		[TestCase("")]
		[TestCase(" \t ")]
		public void EmptyQueryDoesNotSearchOrChangeSelection(string query)
		{
			Selection.activeObject = firstObject;
			object session = Search(query);
			Tick(session);
			Assert.IsFalse(Searching(session));
			Assert.IsEmpty(Results(session));
			Assert.AreSame(firstObject, Selection.activeObject);
		}

		[UnityTest]
		public IEnumerator FindsInactiveObjectsAcrossAdditiveScenesAndExactComponents()
		{
			Selection.activeObject = firstObject;
			object session = Search("spotlightfixture");
			yield return Complete(session);
			var results = Results(session);
			object first = results.Single(item => Target(item) == firstObject);
			object second = results.Single(item => Target(item) == secondObject);
			Assert.AreNotEqual(Description(first), Description(second), "Same-name additive results need distinct paths.");
			StringAssert.Contains("Inactive", Description(second));
			object component = results.Single(item => Target(item) == secondComponent);
			Assert.AreNotEqual(Description(component), Description(results.Single(item => Target(item) == firstComponent)));
			Assert.AreSame(firstObject, Selection.activeObject, "Search must not preview-select results.");
			object refused = Execute(first, "Open");
			Assert.IsFalse(Success(refused));
			Assert.AreEqual("UnsupportedAction", Field(refused, "Code").ToString());
			Assert.AreSame(firstObject, Selection.activeObject);
			Assert.IsTrue(Success(Execute(component, "Select")));
			Assert.AreSame(secondComponent, Selection.activeObject, "Select must keep the exact component identity.");
		}

		[UnityTest]
		public IEnumerator SelectsPersistentAssetAndExactSubAsset()
		{
			var main = ScriptableObject.CreateInstance<SpotlightFixtureAsset>();
			main.name = "SpotlightFixtureMain";
			string path = assetFolder + "/SpotlightFixture.asset";
			AssetDatabase.CreateAsset(main, path);
			var child = ScriptableObject.CreateInstance<SpotlightFixtureAsset>();
			child.name = "SpotlightFixtureChild";
			AssetDatabase.AddObjectToAsset(child, main);
			AssetDatabase.SaveAssets();
			object session = Search("SpotlightFixture");
			yield return Complete(session);
			Assert.AreEqual(1, Results(session).Count(item => Target(item) == main), "Native and loaded-object hits must deduplicate.");
			object result = Results(session).Single(item => Target(item) == child);
			StringAssert.Contains(path, Description(result));
			Assert.IsTrue(Success(Execute(result, "Select")));
			Assert.AreSame(child, Selection.activeObject);
		}

		[UnityTest]
		public IEnumerator ExecutesTheDiscoveredMenuCommandOnce()
		{
			object session = Search("Spotlight Fixture Command");
			yield return Complete(session);
			object result = Results(session).Single(item => (string)Field(item, "Title") == "Spotlight Fixture Command");
			Assert.AreEqual(0, commandCalls);
			Assert.IsTrue(Success(Execute(result, "Execute")));
			Assert.AreEqual(1, commandCalls);
		}

		[UnityTest]
		public IEnumerator StaleResultsRefuseActionsAndDisposedQueriesIgnoreLateBatches()
		{
			object session = Search("SpotlightFixture");
			yield return Complete(session);
			object result = Results(session).Single(item => Target(item) == secondObject);
			Selection.activeObject = firstObject;
			Object.DestroyImmediate(secondObject);
			object outcome = Execute(result, "Select");
			Assert.IsFalse(Success(outcome));
			Assert.AreEqual("Unavailable", Field(outcome, "Code").ToString());
			Assert.AreSame(firstObject, Selection.activeObject);
			object pending = Search("SpotlightFixture");
			((IDisposable)pending).Dispose();
			int count = Results(pending).Length;
			yield return null;
			Tick(pending);
			Assert.IsFalse(Searching(pending));
			Assert.AreEqual(count, Results(pending).Length);
		}

		[UnityTest, Category("SpotlightUI")]
		public IEnumerator ArrowsNavigateWithoutSelectionAndEnterSelectsTheExactResult()
		{
			Open();
			Selection.activeObject = secondObject;
			WindowType.GetField("query", Members).SetValue(palette, "SpotlightFixture BoxCollider");
			WindowType.GetMethod("BeginSearch", Members).Invoke(palette, null);
			double deadline = EditorApplication.timeSinceStartup + 15;
			while (Field(palette, "search") == null && EditorApplication.timeSinceStartup < deadline) yield return null;
			object session = Field(palette, "search");
			Assert.IsNotNull(session, "Palette did not start its query.");
			yield return Complete(session);
			var results = Results(session);
			Assert.GreaterOrEqual(results.Length, 2);
			palette.SendEvent(new Event { type = EventType.KeyDown, keyCode = KeyCode.DownArrow });
			Assert.AreSame(secondObject, Selection.activeObject);
			palette.SendEvent(new Event { type = EventType.KeyDown, keyCode = KeyCode.Return });
			Assert.AreSame(Target(results[1]), Selection.activeObject);
			Assert.IsTrue(palette == null, "The successful action must close the palette.");
		}

		[UnityTest, Category("SpotlightUI")]
		public IEnumerator FocusesAnExistingWindowWithoutOpeningADuplicate()
		{
			owner = ScriptableObject.CreateInstance<SpotlightFixtureWindow>();
			owner.titleContent = new GUIContent("SpotlightFixtureWindow");
			owner.Show();
			Open();
			yield return null;
			object session = Search("SpotlightFixtureWindow");
			yield return Complete(session);
			object result = Results(session).Single(item => Target(item) == owner);
			Assert.IsTrue(Success(Execute(result, "Focus")));
			Assert.AreSame(owner, EditorWindow.focusedWindow);
			Assert.AreEqual(1, Resources.FindObjectsOfTypeAll<SpotlightFixtureWindow>().Length);
		}

		[UnityTest, Category("SpotlightUI")]
		public IEnumerator EscapeRestoresFocusAndKeepsTheOriginalSelection()
		{
			owner = ScriptableObject.CreateInstance<SpotlightFixtureWindow>();
			owner.titleContent = new GUIContent("SpotlightFixtureWindow");
			owner.Show();
			owner.Focus();
			yield return null;
			Selection.activeObject = firstObject;
			Open();
			yield return null;
			palette.SendEvent(new Event { type = EventType.KeyDown, keyCode = KeyCode.Escape });
			Assert.IsTrue(palette == null);
			Assert.AreSame(firstObject, Selection.activeObject);
			Assert.AreSame(owner, EditorWindow.focusedWindow);
		}

		private void Open()
		{
			WindowType.GetMethod("OpenPalette", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
			palette = (EditorWindow)Resources.FindObjectsOfTypeAll(WindowType).Single();
		}

		private object Search(string query)
		{
			object session = Activator.CreateInstance(SearchType, Members, null, new object[] { query }, null);
			sessions.Add((IDisposable)session);
			return session;
		}
		private static IEnumerator Complete(object session)
		{
			double deadline = EditorApplication.timeSinceStartup + 15;
			while (Searching(session) && EditorApplication.timeSinceStartup < deadline) { Tick(session); yield return null; }
			Assert.IsFalse(Searching(session), "Search did not complete within its fixture deadline.");
			Assert.IsEmpty((IEnumerable)Field(session, "Errors"), "A search provider failed.");
		}
		private static void Tick(object session) => SearchType.GetMethod("Tick", Members).Invoke(session, null);
		private static bool Searching(object session) => (bool)SearchType.GetProperty("IsSearching", Members).GetValue(session);
		private static object[] Results(object session) => ((IEnumerable)Field(session, "Results")).Cast<object>().ToArray();
		private static object Field(object instance, string name) => instance.GetType().GetField(name, Members).GetValue(instance);
		private static Object Target(object result) => (Object)Field(result, "Target");
		private static string Description(object result) => (string)Field(result, "Description");
		private static bool Success(object outcome) => (bool)outcome.GetType().GetProperty("Success", Members).GetValue(outcome);
		private static object Execute(object result, string action)
		{
			MethodInfo method = result.GetType().GetMethod("Execute", Members);
			return method.Invoke(result, new[] { Enum.Parse(method.GetParameters()[0].ParameterType, action) });
		}

		[MenuItem("Tools/Unity Cursor Toolkit/Spotlight Fixture Command")]
		private static void FixtureCommand() { commandCalls++; }
	}

	public sealed class SpotlightFixtureWindow : EditorWindow { }
}
