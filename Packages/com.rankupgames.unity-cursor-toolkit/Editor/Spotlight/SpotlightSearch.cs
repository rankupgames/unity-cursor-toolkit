#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace UnityCursorToolkit.Spotlight
{
	internal sealed class SpotlightSearch : IDisposable
	{
		internal readonly List<SpotlightResult> Results = new List<SpotlightResult>();
		internal readonly List<string> Errors = new List<string>();
		private readonly HashSet<Object> objects = new HashSet<Object>();
		private readonly HashSet<string> commands = new HashSet<string>(StringComparer.Ordinal);
		private readonly string query;
		private readonly string[] words;
		private IEnumerator<SpotlightResult> localResults;
		private bool disposed;
		private bool resultsChanged;
#if UNITY_2021_2_OR_NEWER
		private SpotlightUnitySearch unitySearch;
#endif
		internal SpotlightSearch(string text)
		{
			query = text.Trim();
			words = query.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
			if (words.Length == 0) return;
			localResults = EnumerateLocal().GetEnumerator();
#if UNITY_2021_2_OR_NEWER
			unitySearch = new SpotlightUnitySearch(query, Add, Errors.Add);
#endif
		}

		internal bool IsSearching => localResults != null || resultsChanged
#if UNITY_2021_2_OR_NEWER
			|| (unitySearch != null && unitySearch.IsSearching)
#endif
			;

		internal void Tick()
		{
			if (disposed) return;
#if UNITY_2021_2_OR_NEWER
			unitySearch?.Tick();
#endif
			// Yield per object, component, asset, or menu method. Never scan a whole scene in OnGUI.
			try
			{
				for (int step = 0; localResults != null && step < 128; step++)
				{
					if (!localResults.MoveNext())
					{
						localResults.Dispose();
						localResults = null;
						break;
					}
					if (localResults.Current != null) Add(localResults.Current);
				}
			}
			catch (Exception error)
			{
				localResults.Dispose();
				localResults = null;
				Errors.Add("Unity object search failed: " + error.Message + " Retry the search.");
			}
			if (resultsChanged)
			{
				Results.Sort((left, right) =>
				{
					int rank = Rank(left.Title).CompareTo(Rank(right.Title));
					if (rank != 0) return rank;
					int title = string.Compare(left.Title, right.Title, StringComparison.OrdinalIgnoreCase);
					return title != 0 ? title : string.CompareOrdinal(left.Description, right.Description);
				});
				resultsChanged = false;
			}
		}

		private void Add(SpotlightResult result)
		{
			if (disposed) return;
			if (result.Target != null ? !objects.Add(result.Target) : !commands.Add(result.Id)) return;
			Results.Add(result);
			resultsChanged = true;
		}

		private int Rank(string title) => string.Equals(title, query, StringComparison.OrdinalIgnoreCase) ? 0
			: title.StartsWith(query, StringComparison.OrdinalIgnoreCase) ? 1 : 2;

		private bool Matches(string title, string description)
		{
			string value = title + " " + description;
			foreach (string word in words)
				if (value.IndexOf(word, StringComparison.OrdinalIgnoreCase) < 0) return false;
			return true;
		}

		private IEnumerable<SpotlightResult> EnumerateLocal()
		{
			foreach (var window in Resources.FindObjectsOfTypeAll<EditorWindow>())
			{
				if (window == null || window is SpotlightWindow) continue;
				string title = window.titleContent.text;
				string description = window.GetType().FullName + " · Open Editor window";
				yield return !string.IsNullOrEmpty(title) && Matches(title, description)
					? new SpotlightResult(window, title, description) : null;
			}
			for (int sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
			{
				var scene = SceneManager.GetSceneAt(sceneIndex);
				if (!scene.IsValid() || !scene.isLoaded) continue;
				string scenePath = string.IsNullOrEmpty(scene.path) ? scene.name + " (unsaved)" : scene.path;
				// Scene handles distinguish repeated additive loads and untitled scenes.
				scenePath += " [" + scene.handle + "]";
				var pending = new Stack<Transform>();
				foreach (var root in scene.GetRootGameObjects()) pending.Push(root.transform);
				while (pending.Count != 0)
				{
					var transform = pending.Pop();
					if (transform == null) continue;
					yield return null;
					var gameObject = transform.gameObject;
					if ((gameObject.hideFlags & HideFlags.HideInHierarchy) != 0) continue;
					for (int child = transform.childCount - 1; child >= 0; child--) pending.Push(transform.GetChild(child));
					string path = scenePath + " / " + HierarchyPath(transform);
					string state = gameObject.activeInHierarchy ? "" : " · Inactive";
					yield return Matches(gameObject.name, path + " GameObject")
						? new SpotlightResult(gameObject, gameObject.name, path + " · GameObject" + state) : null;
					var components = gameObject.GetComponents<Component>();
					for (int index = 0; index < components.Length; index++)
					{
						var component = components[index];
						if (component == null || (component.hideFlags & HideFlags.HideInInspector) != 0) continue;
						string type = component.GetType().Name;
						string description = path + " · " + type + " component [" + (index + 1) + "]" + state;
						yield return Matches(type, description) ? new SpotlightResult(component, type, description) : null;
					}
				}
			}
			// Persistent loaded objects include exact sub-assets and ScriptableObjects.
			foreach (var item in Resources.FindObjectsOfTypeAll<Object>())
			{
				yield return null;
				if (item == null || !EditorUtility.IsPersistent(item) || (item.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
				string path = AssetDatabase.GetAssetPath(item);
				if (string.IsNullOrEmpty(path)) continue;
				string description = path + " · " + item.GetType().Name;
				yield return Matches(item.name, description) ? new SpotlightResult(item, item.name, description) : null;
			}
#if !UNITY_2021_2_OR_NEWER
			// The declared 2019.4 baseline has no built-in UnityEditor.Search assembly.
			foreach (string guid in AssetDatabase.FindAssets(query))
			{
				string path = AssetDatabase.GUIDToAssetPath(guid);
				var asset = AssetDatabase.LoadMainAssetAtPath(path);
				yield return asset != null ? new SpotlightResult(asset, asset.name, path + " · " + asset.GetType().Name) : null;
			}
			foreach (var method in TypeCache.GetMethodsWithAttribute<MenuItem>())
			{
				foreach (MenuItem menu in method.GetCustomAttributes(typeof(MenuItem), false))
				{
					if (menu.validate || menu.menuItem.StartsWith("CONTEXT/", StringComparison.Ordinal)) continue;
					string path = RemoveShortcut(menu.menuItem);
					if (!Matches(path, "Menu command")) continue;
					yield return new SpotlightResult("menu:" + path, path.Substring(path.LastIndexOf('/') + 1), path + " · Menu command",
						() => EditorApplication.ExecuteMenuItem(path) ? SpotlightActionResult.Ok : new SpotlightActionResult(SpotlightError.Unavailable, "This menu command is unavailable. Check its Editor context and retry."));
				}
				yield return null;
			}
#endif
		}

		private static string HierarchyPath(Transform transform)
		{
			var parts = new Stack<string>();
			for (var item = transform; item != null; item = item.parent)
				parts.Push(item.name + " [" + item.GetSiblingIndex() + "]");
			return string.Join(" / ", parts.ToArray());
		}

#if !UNITY_2021_2_OR_NEWER
		private static string RemoveShortcut(string path)
		{
			int space = path.LastIndexOf(' ');
			if (space >= 0 && space + 1 < path.Length && "%#&_".IndexOf(path[space + 1]) >= 0) return path.Substring(0, space);
			return path;
		}
#endif

		public void Dispose()
		{
			disposed = true;
			resultsChanged = false;
			localResults?.Dispose();
			localResults = null;
#if UNITY_2021_2_OR_NEWER
			unitySearch?.Dispose();
			unitySearch = null;
#endif
		}
	}
}

#endif
