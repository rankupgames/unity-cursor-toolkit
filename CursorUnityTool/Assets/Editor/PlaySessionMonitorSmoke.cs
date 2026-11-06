using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace UnityCursorToolkit.InternalSmoke
{
	/// <summary>Native object/serialization contracts; lifecycle delivery is proved by a real monitored Play session.</summary>
	public static class PlaySessionMonitorSmoke
	{
		[MenuItem("Tools/Unity Cursor Toolkit/Validation/Session Snapshot Contracts")]
		public static void RunSnapshotContracts()
		{
			if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("Session contract smoke requires idle Edit Mode.");
			Assembly assembly = typeof(HotReloadHandler).Assembly;
			Type toolType = assembly.GetType("UnityCursorToolkit.MCP.PlaySessionTool", true);
			object tool = Activator.CreateInstance(toolType, true);
			MethodInfo handle = toolType.GetMethod("HandleCommand");
			string[] malformed =
			{
				"{", "{\"action\":\"status\",}", "{\"action\":\"status\",\"action\":\"capture\"}",
				"{\"action\":\"configure\"}", "{\"action\":\"configure\",\"enabled\":\"true\"}",
				"{\"action\":\"configure\",\"enabled\":null}", "{\"action\":\"status\",\"extra\":1}",
				"{\"action\":\"events\",\"afterSequence\":-1}", "{\"action\":\"events\",\"afterSequence\":9007199254740992}",
				"{\"action\":\"events\",\"limit\":0}", "{\"action\":\"events\",\"limit\":101}",
				"{\"action\":\"events\",\"afterSequence\":1.2}", "{\"action\":\"events\",\"limit\":[]}",
				"{\"action\":\"read\",\"sessionId\":\"../outside\"}",
				"{\"action\":\"read\",\"sessionId\":\"play_20261106_120000_0123abcd\",\"snapshotId\":\"../outside\"}",
				"{\"action\":\"read\",\"sessionId\":\"play_20261106_120000_0123abcd\",\"snapshotId\":\"snapshot-0009\"}",
				"{\"action\":\"capture\",\"reason\":\"\"}", "{\"action\":\"capture\",\"reason\":\"\\uD800\"}"
			};
			string prior = (string)handle.Invoke(tool, new object[] { "{\"action\":\"status\"}" });
			for (int i = 0; i < malformed.Length; i++)
			{
				string result = (string)handle.Invoke(tool, new object[] { malformed[i] });
				Require(result.Contains("\"success\":false") && result.Contains("\"code\":\"invalid_arguments\""), "Malformed case " + i + " was accepted: " + result);
			}
			Require(prior == (string)handle.Invoke(tool, new object[] { "{\"action\":\"status\"}" }), "Rejected requests changed recorder state.");
			ValidateContextSelection(assembly);

			Scene original = SceneManager.GetActiveScene();
			Scene owned = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
			GameObject root = null;
			try
			{
				SceneManager.SetActiveScene(owned);
				root = new GameObject("Session snapshot \"root\"");
				SceneManager.MoveGameObjectToScene(root, owned);
				root.layer = 2;
				root.tag = "Player";
				root.transform.position = new Vector3(3, 4, 5);
				root.transform.rotation = Quaternion.Euler(0, 25, 0);
				root.transform.localScale = new Vector3(2, 3, 4);
				GameObject first = new GameObject("First child");
				first.transform.SetParent(root.transform, false);
				first.transform.localPosition = new Vector3(1, 2, 3);
				first.SetActive(false);
				GameObject second = new GameObject("Second child");
				second.transform.SetParent(root.transform, false);
				var probe = root.AddComponent<PlaySessionSnapshotProbe>();
				probe.assigned = second;
				BoxCollider collider = root.AddComponent<BoxCollider>();
				collider.enabled = false;

				Type builder = assembly.GetType("UnityCursorToolkit.PlaySessionSnapshotBuilder", true);
				object snapshot = builder.GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null,
					new object[] { "play_20261106_120000_0123abcd", "snapshot-0001", "native_contract_smoke", null });
				var data = JsonUtility.FromJson<Snapshot>(JsonUtility.ToJson(snapshot));
				Require(!data.truncated, "Native contract world exceeded snapshot limits; no partial result counts as proof.");
				Row rootRow = Find(data.objects, root.GetInstanceID());
				Row firstRow = Find(data.objects, first.GetInstanceID());
				Row secondRow = Find(data.objects, second.GetInstanceID());
				Require(rootRow.parentInstanceId == 0 && firstRow.parentInstanceId == rootRow.instanceId && secondRow.parentInstanceId == rootRow.instanceId, "Parent IDs do not preserve the actual hierarchy.");
				Require(firstRow.siblingIndex == 0 && secondRow.siblingIndex == 1, "Sibling order changed.");
				Require(rootRow.layer == 2 && rootRow.tag == "Player" && rootRow.position == root.transform.position, "World position/layer/tag do not match Unity.");
				Require(rootRow.rotation == root.transform.rotation && rootRow.localScale == root.transform.localScale, "Rotation or local scale was lost.");
				Require(firstRow.localPosition == first.transform.localPosition && !firstRow.activeSelf && !firstRow.activeInHierarchy, "Inactive child state or local transform is absent.");
				ComponentRow capturedProbe = FindComponent(rootRow, probe.GetInstanceID());
				Require(capturedProbe.type == typeof(PlaySessionSnapshotProbe).FullName && capturedProbe.slot == 1, "Component identity/type/slot does not match the actual component.");
				ComponentRow capturedCollider = FindComponent(rootRow, collider.GetInstanceID());
				Require(capturedCollider.slot == 2 && capturedCollider.hasEnabled && !capturedCollider.enabled, "The actual disabled Collider state was lost.");
				Reference unassigned = capturedProbe.references.Find(item => item.propertyPath == "unassigned");
				Reference assigned = capturedProbe.references.Find(item => item.propertyPath == "assigned");
				Require(unassigned != null && unassigned.state == "unassigned" && unassigned.instanceId == 0, "Unassigned reference was mislabeled.");
				Require(assigned != null && assigned.state == "assigned" && assigned.instanceId == second.GetInstanceID(), "Assigned reference identity was lost.");
				string json = JsonUtility.ToJson(snapshot);
				Require(!json.Contains("UCT_VALUE_MUST_NOT_BE_CAPTURED"), "Serialized string values leaked into the diagnostic snapshot.");

				Type profiler = assembly.GetType("UnityCursorToolkit.LoadedSceneCapture", true);
				object[] args = { null };
				object scenes = profiler.GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args);
				var rows = (IList)scenes;
				bool sawUnsaved = false;
				for (int i = 0; i < rows.Count; i++)
				{
					object item = rows[i];
					Type type = item.GetType();
					if (!(bool)type.GetField("isActive").GetValue(item)) continue;
					Require((string)type.GetField("path").GetValue(item) == string.Empty, "Unsaved active scene lost its empty path.");
					Require((string)type.GetField("name").GetValue(item) == owned.name, "Unsaved active scene name was lost.");
					sawUnsaved = true;
				}
				Require(sawUnsaved && (string)args[0] == string.Empty, "Active/loaded scene capture did not share the current scene snapshot.");
			}
			finally
			{
				if (root) Object.DestroyImmediate(root);
				if (original.IsValid() && original.isLoaded) SceneManager.SetActiveScene(original);
				if (owned.IsValid() && owned.isLoaded) EditorSceneManager.CloseScene(owned, true);
			}
			Debug.Log("Session snapshot contracts passed:18 malformed-argument cases,4 console-boundary attribution cases and native hierarchy/reference/scene contracts. Play lifecycle, reload, budget exhaustion and native error-context attribution require separate monitored Play proof.");
		}

		private static void ValidateContextSelection(Assembly assembly)
		{
			Type native = assembly.GetType("UnityCursorToolkit.NativeConsoleContext", true);
			Type rowType = native.GetNestedType("ConsoleRow", BindingFlags.Public | BindingFlags.NonPublic);
			Type errorType = assembly.GetType("UnityCursorToolkit.PlaySessionError", true);
			Type snapshotType = assembly.GetType("UnityCursorToolkit.PlaySessionSnapshot", true);
			Type listType = typeof(List<>).MakeGenericType(rowType);
			string text = "UCT_CONTEXT_BOUNDARY_SMOKE";
			string stack = "Fixture.Context.Execute ()";
			for (int variant = 0; variant < 4; variant++)
			{
				object error = Activator.CreateInstance(errorType, true);
				errorType.GetField("message").SetValue(error, text);
				errorType.GetField("stackTrace").SetValue(error, stack);
				object snapshot = Activator.CreateInstance(snapshotType, true);
				snapshotType.GetField("consoleStartIndex").SetValue(snapshot, 10);
				snapshotType.GetField("consoleEndIndex").SetValue(snapshot, 12);
				var rows = (IList)Activator.CreateInstance(listType);
				object older = Activator.CreateInstance(rowType, true);
				rowType.GetField("index").SetValue(older, variant == 1 || variant == 2 ? 10 : 9);
				rowType.GetField("instanceId").SetValue(older, 71);
				rowType.GetField("text").SetValue(older, text + "\n" + stack);
				rows.Add(older);
				if (variant != 3)
				{
					object latest = Activator.CreateInstance(rowType, true);
					rowType.GetField("index").SetValue(latest, 11);
					rowType.GetField("instanceId").SetValue(latest, variant == 2 ? 72 : 0);
					rowType.GetField("text").SetValue(latest, text + "\n" + (variant == 2 ? "Fixture.Different.Execute ()" : stack));
					rows.Add(latest);
				}
				native.GetMethod("MatchRows", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new[] { rows, error, snapshot });
				Require((int)snapshotType.GetField("contextInstanceId").GetValue(snapshot) == 0 &&
					!(bool)snapshotType.GetField("contextPrioritized").GetValue(snapshot), "A native message candidate was promoted to exact current context.");
				var matches = (IList)snapshotType.GetField("consoleMatches").GetValue(snapshot);
				if (variant == 3)
				{
					Require(matches.Count == 0, "A previous session's same-message context crossed the active session boundary.");
					continue;
				}
				Require((int)snapshotType.GetField("matchedConsoleIndex").GetValue(snapshot) == 11, "The newest same-message entry was skipped.");
				string evidence = (string)snapshotType.GetField("contextEvidence").GetValue(snapshot);
				Require(evidence == (variant == 2 ? "native_latest_match_stack_unproven" : "native_latest_match_contextless"),
					"A contextless or incompatible current entry fell back to an older contextual entry.");
				for (int i = 0; i < matches.Count; i++)
					Require((int)matches[i].GetType().GetField("index").GetValue(matches[i]) >= 10, "Evidence includes a pre-session native console row.");
			}
		}

		private static Row Find(List<Row> rows, int id)
		{
			Row value = rows.Find(row => row.instanceId == id);
			Require(value != null, "A synthetic object was absent from the complete snapshot.");
			return value;
		}
		private static ComponentRow FindComponent(Row row, int id)
		{
			ComponentRow value = row.components.Find(component => component.instanceId == id);
			Require(value != null, "The synthetic component was absent from its captured object.");
			return value;
		}
		private static void Require(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); }

		[Serializable] private sealed class Snapshot { public bool truncated; public List<Row> objects; }
		[Serializable] private sealed class Row
		{
			public int instanceId, parentInstanceId, siblingIndex, layer;
			public string tag;
			public Vector3 position, localPosition, localScale;
			public Quaternion rotation;
			public bool activeSelf, activeInHierarchy;
			public List<ComponentRow> components;
		}
		[Serializable] private sealed class ComponentRow { public int instanceId, slot; public string type; public bool hasEnabled, enabled; public List<Reference> references; }
		[Serializable] private sealed class Reference { public string propertyPath, state; public int instanceId; }
	}

}
