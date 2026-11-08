#if UNITY_EDITOR

using System;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace UnityCursorToolkit.Spotlight
{
	internal enum SpotlightAction { Select, Open, Focus, Ping, Frame, Execute }
	internal enum SpotlightError { None, Unavailable, UnsupportedAction, EditorFailure }

	internal readonly struct SpotlightActionResult
	{
		internal readonly SpotlightError Code;
		internal readonly string Message;
		internal bool Success => Code == SpotlightError.None;
		internal SpotlightActionResult(SpotlightError code, string message) { Code = code; Message = message; }
		internal static SpotlightActionResult Ok => new SpotlightActionResult(SpotlightError.None, string.Empty);
	}

	internal sealed class SpotlightResult
	{
		internal readonly string Id;
		internal readonly string Title;
		internal readonly string Description;
		internal readonly Object Target;
		internal readonly SpotlightAction DefaultAction;
		internal readonly SpotlightAction[] Actions;
		private readonly Func<SpotlightActionResult> executeCommand;

		internal SpotlightResult(Object target, string title, string description)
		{
			Target = target;
			Title = title;
			Description = description;
			if (target is EditorWindow)
			{
				DefaultAction = SpotlightAction.Focus;
				Actions = new[] { SpotlightAction.Focus };
			}
			else
			{
				DefaultAction = SpotlightAction.Select;
				Actions = !EditorUtility.IsPersistent(target) && (target is GameObject || target is Component)
					? new[] { SpotlightAction.Select, SpotlightAction.Ping, SpotlightAction.Frame }
					: new[] { SpotlightAction.Select, SpotlightAction.Open, SpotlightAction.Ping };
			}
		}

		internal SpotlightResult(string id, string title, string description, Func<SpotlightActionResult> execute)
		{
			Id = id;
			Title = title;
			Description = description;
			executeCommand = execute;
			DefaultAction = SpotlightAction.Execute;
			Actions = new[] { SpotlightAction.Execute };
		}

		internal bool IsAvailable => executeCommand != null || Target != null;

		// Failures stay in the palette and do not close it.
		internal SpotlightActionResult Execute(SpotlightAction action)
		{
			if (Array.IndexOf(Actions, action) < 0)
				return new SpotlightActionResult(SpotlightError.UnsupportedAction, "This action is unavailable. Choose another result action.");
			if (!IsAvailable)
				return new SpotlightActionResult(SpotlightError.Unavailable, "This item is no longer available. Search again.");
			try
			{
				switch (action)
				{
					case SpotlightAction.Execute: return executeCommand();
					case SpotlightAction.Focus: ((EditorWindow)Target).Focus(); break;
					case SpotlightAction.Select: Selection.activeObject = Target; break;
					case SpotlightAction.Ping: EditorGUIUtility.PingObject(Target); break;
					case SpotlightAction.Open:
						if (!AssetDatabase.OpenAsset(Target)) return new SpotlightActionResult(SpotlightError.EditorFailure, "Unity could not open this asset. Select it and use its Inspector.");
						break;
					case SpotlightAction.Frame:
						var view = SceneView.lastActiveSceneView;
						if (view == null) return new SpotlightActionResult(SpotlightError.Unavailable, "No Scene view is open. Open a Scene view and retry.");
						var previousSelection = Selection.objects;
						Selection.activeObject = Target;
						if (!view.FrameSelected())
						{
							Selection.objects = previousSelection;
							return new SpotlightActionResult(SpotlightError.EditorFailure, "Unity could not frame this item. Select it and check the Scene view.");
						}
						view.Focus();
						break;
				}
				return SpotlightActionResult.Ok;
			}
			catch (ExitGUIException) { throw; }
			catch (Exception error)
			{
				return new SpotlightActionResult(SpotlightError.EditorFailure, "Unity could not " + action.ToString().ToLowerInvariant() + " this item: " + error.Message + " Search again or choose another action.");
			}
		}
	}
}

#endif
