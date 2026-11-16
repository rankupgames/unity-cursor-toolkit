#if UNITY_EDITOR && UNITY_2021_2_OR_NEWER

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Search;
using UnityEngine;

namespace UnityCursorToolkit.Spotlight
{
	// Only this adapter depends on the built-in Search API (Unity 2021.2 and later).
	internal sealed class SpotlightUnitySearch : IDisposable
	{
		private readonly List<SearchContext> contexts = new List<SearchContext>();
		private readonly Action<string> reportFailure;
		private readonly double deadline;
		private bool disposed;
		private int pending;
		internal bool IsSearching => pending > 0;

		internal SpotlightUnitySearch(string query, Action<SpotlightResult> add, Action<string> fail)
		{
			reportFailure = fail;
			deadline = EditorApplication.timeSinceStartup + 30;
			foreach (string providerId in new[] { "asset", "menu", "settings" })
			{
				bool requestStarted = false;
				try
				{
					var provider = SearchService.GetProvider(providerId);
					if (provider == null)
					{
						fail(providerId + " search is unavailable. Enable the Unity Search provider and retry.");
						continue;
					}
					var context = SearchService.CreateContext(provider, query);
					contexts.Add(context);
					pending++;
					requestStarted = true;
					SearchService.Request(context, (incomingContext, items) =>
					{
						if (disposed || !requestStarted) return;
						try
						{
							foreach (var item in items)
							{
								if (item == null) continue;
								string title = item.GetLabel(incomingContext, true);
								var target = providerId == "asset" ? item.ToObject() : null;
								if (target != null)
								{
									string path = AssetDatabase.GetAssetPath(target);
									add(new SpotlightResult(target, title, path + " · " + target.GetType().Name));
								}
								else if (providerId != "asset")
								{
									var command = item;
									add(new SpotlightResult(providerId + ":" + item.id, title,
										item.GetDescription(incomingContext, true) + (providerId == "menu" ? " · Menu command" : " · Settings"),
										() => Execute(command)));
								}
							}
						}
						catch (Exception error) { fail(providerId + " search failed: " + error.Message + " Retry the search."); }
					}, completedContext =>
					{
						if (disposed || !requestStarted) return;
						requestStarted = false;
						pending--;
					}, SearchFlags.Default);
				}
				catch (Exception error)
				{
					// A failed request cannot keep the palette in its searching state.
					if (requestStarted) { requestStarted = false; pending--; }
					fail(providerId + " search failed: " + error.Message + " Retry the search.");
				}
			}
		}

		internal void Tick()
		{
			if (disposed || pending == 0 || EditorApplication.timeSinceStartup < deadline) return;
			reportFailure("Unity Search did not finish within 30 seconds. Wait for indexing to finish, then retry.");
			Dispose();
		}

		private SpotlightActionResult Execute(SearchItem item)
		{
			if (disposed) return new SpotlightActionResult(SpotlightError.Unavailable, "This search has ended. Search again before running the command.");
			var actions = item.provider.actions;
			if (actions.Count == 0) return new SpotlightActionResult(SpotlightError.Unavailable, "This command has no Unity action. Choose another result.");
			var action = actions[0];
			var items = new[] { item };
			if (action.enabled != null && !action.enabled(items))
				return new SpotlightActionResult(SpotlightError.Unavailable, "This command is unavailable in the current Editor context. Change context and retry.");
			if (action.handler != null) action.handler(item);
			else if (action.execute != null) action.execute(items);
			else return new SpotlightActionResult(SpotlightError.Unavailable, "This command has no Unity action. Choose another result.");
			return SpotlightActionResult.Ok;
		}

		public void Dispose()
		{
			disposed = true;
			foreach (var context in contexts) context.Dispose();
			contexts.Clear();
			pending = 0;
		}
	}
}

#endif
