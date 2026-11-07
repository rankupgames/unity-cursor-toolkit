using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
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
				"{\"action\":\"compact\"}", "{\"action\":\"compact\",\"sessionId\":\"../outside\"}",
				"{\"action\":\"compare\",\"sessionId\":7}", "{\"action\":\"timeline\",\"limit\":101}",
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
				EditorSceneManager.MoveSceneBefore(owned, SceneManager.GetSceneAt(0));
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
				Require(probe, "The snapshot probe must be compiled outside Editor folders and remain guarded by UNITY_EDITOR.");
				probe.assigned = second;
				BoxCollider collider = root.AddComponent<BoxCollider>();
				collider.enabled = false;

				Type builder = assembly.GetType("UnityCursorToolkit.PlaySessionSnapshotBuilder", true);
				object snapshot = builder.GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null,
					new object[] { "play_20261106_120000_0123abcd", "snapshot-0001", "native_contract_smoke", null });
				var data = JsonUtility.FromJson<Snapshot>(JsonUtility.ToJson(snapshot));
				// This fixture proves its own rows. A large consumer world can hit unrelated row budgets.
				if (data.truncated) Debug.Log("Snapshot contract world was truncated; only the complete owned fixture is checked.");
				Row rootRow = Find(data.objects, root.GetInstanceID());
				Row firstRow = Find(data.objects, first.GetInstanceID());
				Row secondRow = Find(data.objects, second.GetInstanceID());
				Require(!rootRow.componentsTruncated && !firstRow.componentsTruncated && !secondRow.componentsTruncated, "Owned fixture components were truncated.");
				Require(rootRow.childCount == 2 && rootRow.sceneHandle == owned.handle, "Child count or scene identity was lost.");
				Require(rootRow.parentInstanceId == 0 && firstRow.parentInstanceId == rootRow.instanceId && secondRow.parentInstanceId == rootRow.instanceId, "Parent IDs do not preserve the actual hierarchy.");
				Require(firstRow.siblingIndex == 0 && secondRow.siblingIndex == 1, "Sibling order changed.");
				Require(rootRow.layer == 2 && rootRow.tag == "Player" && rootRow.position == root.transform.position, "World position/layer/tag do not match Unity.");
				Require(rootRow.rotation == root.transform.rotation && rootRow.localScale == root.transform.localScale, "Rotation or local scale was lost.");
				Require(firstRow.localPosition == first.transform.localPosition && !firstRow.activeSelf && !firstRow.activeInHierarchy, "Inactive child state or local transform is absent.");
				ComponentRow capturedProbe = FindComponent(rootRow, probe.GetInstanceID());
				Require(!capturedProbe.referencesTruncated, "Owned probe reference capture was truncated.");
				Require(capturedProbe.type == typeof(PlaySessionSnapshotProbe).FullName && capturedProbe.slot == 1, "Component identity/type/slot does not match the actual component.");
				ComponentRow capturedCollider = FindComponent(rootRow, collider.GetInstanceID());
				Require(capturedCollider.slot == 2 && capturedCollider.hasEnabled && !capturedCollider.enabled, "The actual disabled Collider state was lost.");
				Reference unassigned = capturedProbe.references.Find(item => item.propertyPath == "unassigned");
				Reference assigned = capturedProbe.references.Find(item => item.propertyPath == "assigned");
				Require(unassigned != null && unassigned.state == "unassigned" && unassigned.instanceId == 0, "Unassigned reference was mislabeled.");
				Require(assigned != null && assigned.state == "assigned" && assigned.instanceId == second.GetInstanceID(), "Assigned reference identity was lost.");
				Type errorType = assembly.GetType("UnityCursorToolkit.PlaySessionError", true);
				foreach (string stack in new[]
				{
					typeof(PlaySessionSnapshotProbe).FullName + ".Execute ()",
					" #8 (Mono JIT Code) [PlaySessionSnapshotProbe.cs:1] " + typeof(PlaySessionSnapshotProbe).FullName + ":Execute ()"
				})
				{
					object error = Activator.CreateInstance(errorType, true);
					errorType.GetField("stackTrace").SetValue(error, stack);
					snapshot.GetType().GetField("error").SetValue(snapshot, error);
					((IList)snapshot.GetType().GetField("candidateComponentIds").GetValue(snapshot)).Clear();
					((IList)snapshot.GetType().GetField("candidateObjectIds").GetValue(snapshot)).Clear();
					builder.GetMethod("Correlate", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new[] { snapshot });
					Require(((IList)snapshot.GetType().GetField("candidateComponentIds").GetValue(snapshot)).Contains(probe.GetInstanceID()) &&
						((IList)snapshot.GetType().GetField("candidateObjectIds").GetValue(snapshot)).Contains(root.GetInstanceID()), "The native/managed stack did not identify the fixture component and owner as candidates.");
				}
				ValidateCaughtErrorCorrelation(assembly, builder, snapshot, probe);
				ValidatePriorityBudget(builder, owned, root, probe);
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
			Debug.Log("Session snapshot contracts passed:22 malformed-argument cases,4 console-boundary attribution cases and native hierarchy/reference/scene contracts. Play lifecycle, reload, budget exhaustion and native error-context attribution require separate monitored Play proof.");
		}

		[MenuItem("Tools/Unity Cursor Toolkit/Validation/Session Storage Contracts")]
		public static void RunStorageContracts()
		{
			if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating)
				throw new InvalidOperationException("Storage contracts require idle Edit Mode.");
			Assembly assembly = typeof(HotReloadHandler).Assembly;
			Type monitor = assembly.GetType("UnityCursorToolkit.PlaySessionMonitor", true);
			string root = (string)monitor.GetProperty("Root", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
			Type storage = assembly.GetType("UnityCursorToolkit.PlaySessionStorage", true);
			MethodInfo read = storage.GetMethod("Read", BindingFlags.Static | BindingFlags.NonPublic);
			Type toolType = assembly.GetType("UnityCursorToolkit.MCP.PlaySessionTool", true);
			object tool = Activator.CreateInstance(toolType, true);
			MethodInfo handle = toolType.GetMethod("HandleCommand");
			Func<string, string> command = args => (string)handle.Invoke(tool, new object[] { args });
			string first = "play_" + DateTime.UtcNow.ToString("yyyyMMdd_HHmmss") + "_" + Guid.NewGuid().ToString("N").Substring(0, 8);
			string second = "play_" + DateTime.UtcNow.ToString("yyyyMMdd_HHmmss") + "_" + Guid.NewGuid().ToString("N").Substring(0, 8);
			string blocks = Path.Combine(root, "blocks");
			var priorPacks = new HashSet<string>(Directory.Exists(blocks) ? Directory.GetFiles(blocks) : new string[0]);
			var ownedPacks = new HashSet<string>();
			string journalFixture = Path.Combine(Path.GetTempPath(), "toolkit-timeline-" + Guid.NewGuid().ToString("N"));
			try
			{
				string marker = Guid.NewGuid().ToString("N");
				byte[] original = StorageFixture(root, first, marker);
				byte[] other = StorageFixture(root, second, marker);
				string readArgs = "{\"action\":\"read\",\"sessionId\":\"" + first + "\",\"snapshotId\":\"snapshot-0001\",\"limit\":1}";
				string page = command(readArgs);
				Require(page.Contains("\"nextOffset\":1") && page.Contains("\"capturedObjectCount\":2") && page.Contains("\"hasMore\":true"), "Legacy pagination did not preserve the captured row count.");
				foreach (string id in new[] { first, second })
				{
					string result = command("{\"action\":\"compact\",\"sessionId\":\"" + id + "\"}");
					Require(result.Contains("\"compacted\":1"), "Completed fixture was not compacted: " + result);
					foreach (StorageBlock block in JsonUtility.FromJson<StorageManifest>(File.ReadAllText(Path.Combine(root, id, "snapshot-0001.manifest.json"))).blocks)
					{
						string packFile = Path.Combine(blocks, "pack-" + block.pack + ".bin");
						if (!priorPacks.Contains(packFile)) ownedPacks.Add(packFile);
					}
				}
				Require(BytesEqual(original, (byte[])read.Invoke(null, new object[] { root, first, "snapshot-0001" })) &&
					BytesEqual(other, (byte[])read.Invoke(null, new object[] { root, second, "snapshot-0001" })), "Unicode, float tokens, order or exact snapshot bytes changed.");
				Require(command(readArgs) == page, "Compressed snapshot changed the v1 page contract.");
				string firstManifest = Path.Combine(root, first, "snapshot-0001.manifest.json");
				string secondManifest = Path.Combine(root, second, "snapshot-0001.manifest.json");
				var manifest = JsonUtility.FromJson<StorageManifest>(File.ReadAllText(firstManifest));
				var next = JsonUtility.FromJson<StorageManifest>(File.ReadAllText(secondManifest));
				bool shared = false, unique = false;
				foreach (StorageBlock a in manifest.blocks) foreach (StorageBlock b in next.blocks)
					if (a.sha256 == b.sha256 && a.pack == b.pack && a.offset == b.offset) shared = true;
				foreach (StorageBlock b in next.blocks) if (!manifest.blocks.Exists(a => a.sha256 == b.sha256)) unique = true;
				Require(shared && unique, "Captures must share exact blocks and retain distinct bytes.");
				long bytesBefore = DirectoryBytes(root);
				Require(command("{\"action\":\"compact\",\"sessionId\":\"" + first + "\"}").Contains("\"alreadyCompacted\":1") && DirectoryBytes(root) == bytesBefore, "Repeated compaction wrote duplicate storage.");
				// Simulate interruption after immutable publication but before descriptor replacement.
				File.WriteAllBytes(Path.Combine(root, first, "snapshot-0001.json"), original);
				Require(command("{\"action\":\"compact\",\"sessionId\":\"" + first + "\"}").Contains("\"compacted\":1") && DirectoryBytes(root) == bytesBefore, "Interrupted publication was not idempotent.");
				ValidateStagingRecovery(command, read, root, first, original, manifest, bytesBefore, priorPacks);
				string compare = command("{\"action\":\"compare\",\"sessionId\":\"" + first + "\",\"snapshotId\":\"snapshot-0001\",\"otherSessionId\":\"" + second + "\",\"otherSnapshotId\":\"snapshot-0001\"}");
				Require(compare.Contains("\"objectComparisonAvailable\":false") && compare.Contains("cross_session_identity_not_assumed") && compare.Contains("\"secondBytesSharedWithFirst\":") && !compare.Contains("\"secondBytesSharedWithFirst\":0"), "Cross-session IDs were treated as shared object identity.");
				string saved = File.ReadAllText(firstManifest);
				foreach (string invalid in new[]
				{
					saved.Replace("\"offset\":" + manifest.blocks[0].offset, "\"offset\":9223372036854775807"),
					saved.Replace(manifest.blocks[0].pack, "../outside"),
					saved.Replace("\"decodedBytes\":" + manifest.decodedBytes, "\"decodedBytes\":8388609"),
					saved.Replace(manifest.blocks[0].sha256, new string('0', 64)),
					saved.Substring(0, saved.Length / 2)
				})
				{
					File.WriteAllText(firstManifest, invalid);
					Require(command(readArgs).Contains("\"success\":false"), "Invalid manifest was accepted.");
				}
				File.WriteAllText(firstManifest, saved);
				string packPath = Path.Combine(blocks, "pack-" + manifest.blocks[0].pack + ".bin");
				Require(!priorPacks.Contains(packPath), "Corruption fixture must own its pack.");
				byte[] pack = File.ReadAllBytes(packPath);
				byte[] corrupt = (byte[])pack.Clone(); corrupt[(int)manifest.blocks[0].offset] = 0;
				File.WriteAllBytes(packPath, corrupt);
				Require(command(readArgs).Contains("\"success\":false"), "Corrupt gzip was accepted.");
				File.WriteAllBytes(packPath, new byte[12]);
				Require(command(readArgs).Contains("\"success\":false"), "Truncated pack was accepted.");
				File.WriteAllBytes(packPath, pack);
				File.Delete(packPath);
				Require(command(readArgs).Contains("\"success\":false"), "Missing immutable pack was accepted.");
				File.WriteAllBytes(packPath, pack);
				File.WriteAllText(Path.Combine(root, first, "snapshot-0002.json"), "{\"version\":1,\"id\":\"snapshot-0002\",\"sessionId\":\"" + first + "\",\"objects\":[{\"instanceId\":1,\"name\":\"changed\"},{\"instanceId\":3,\"name\":\"new\"}]}");
				string changes = command("{\"action\":\"compare\",\"sessionId\":\"" + first + "\",\"snapshotId\":\"snapshot-0001\",\"otherSessionId\":\"" + first + "\",\"otherSnapshotId\":\"snapshot-0002\",\"limit\":1}");
				Require(changes.Contains("\"capturedChangeCount\":3") && changes.Contains("\"nextOffset\":1") && changes.Contains("\"kind\":\"changed\"") && changes.Contains("\"firstTruncated\":true"), "Same-session changes or truncation were lost.");
				Directory.Delete(Path.Combine(root, second), true);
				Require(BytesEqual(original, (byte[])read.Invoke(null, new object[] { root, first, "snapshot-0001" })), "Historical read depends on the latest session.");
				Directory.CreateDirectory(journalFixture);
				string events = "{\"version\":1,\"sequence\":1,\"sessionId\":\"" + first + "\",\"kind\":\"session_started\"}\n" +
					"{\"version\":1,\"sequence\":2,\"sessionId\":\"" + first + "\",\"kind\":\"error_observed\",\"errorCount\":3}\n" +
					"{\"version\":1,\"sequence\":3,\"sessionId\":\"" + second + "\",\"kind\":\"session_started\"}\n";
				File.WriteAllText(Path.Combine(journalFixture, "events.jsonl"), events);
				MethodInfo timeline = assembly.GetType("UnityCursorToolkit.PlaySessionTimeline", true).GetMethod("Events", BindingFlags.Static | BindingFlags.NonPublic);
				string eventPage = (string)timeline.Invoke(null, new object[] { journalFixture, 0L, 2, true, false });
				string following = (string)timeline.Invoke(null, new object[] { journalFixture, 2L, 2, true, false });
				Require(eventPage.Contains("\"nextSequence\":2") && eventPage.Contains("\"errorCount\":3") && eventPage.Contains("\"hasMore\":true") && following.Contains(second), "Master timeline lost occurrence data or session boundaries.");
				Require(File.ReadAllText(Path.Combine(journalFixture, "events.jsonl")) == events, "Timeline reads mutated the journal.");
				File.AppendAllText(Path.Combine(journalFixture, "events.jsonl"), "{\"version\":1,\"sequence\":3}\n");
				Require(((string)timeline.Invoke(null, new object[] { journalFixture, 0L, 100, true, false })).Contains("journal_invalid"), "Duplicate event order was silently accepted.");
			}
			finally
			{
				foreach (string id in new[] { first, second }) if (Directory.Exists(Path.Combine(root, id))) Directory.Delete(Path.Combine(root, id), true);
				foreach (string path in ownedPacks)
				{
					if (File.Exists(path)) File.Delete(path);
					if (File.Exists(path + ".pending")) File.Delete(path + ".pending");
				}
				if (Directory.Exists(journalFixture)) Directory.Delete(journalFixture, true);
			}
			Debug.Log("Session storage contracts passed. Live migrations and player performance remain separate proof.");
		}

		private static void ValidateStagingRecovery(Func<string, string> command, MethodInfo read, string root, string session, byte[] original,
			StorageManifest manifest, long physicalBytes, HashSet<string> priorPacks)
		{
			string capture = Path.Combine(root, session, "snapshot-0001.json");
			string manifestPath = Path.Combine(root, session, "snapshot-0001.manifest.json");
			string packPath = Path.Combine(root, "blocks", "pack-" + manifest.blocks[0].pack + ".bin");
			Require(!priorPacks.Contains(packPath) && manifest.blocks.TrueForAll(block => block.pack == manifest.blocks[0].pack), "Staging fixture must own one complete pack.");
			byte[] descriptor = File.ReadAllBytes(capture), manifestBytes = File.ReadAllBytes(manifestPath), packBytes = File.ReadAllBytes(packPath);
			string compact = "{\"action\":\"compact\",\"sessionId\":\"" + session + "\"}";
			for (int stage = 0; stage < 3; stage++)
			{
				File.WriteAllBytes(capture, original);
				string pending; byte[] expected;
				if (stage == 0) { pending = Path.Combine(root, session, "snapshot-0001.storage-pending"); expected = descriptor; }
				else
				{
					File.Delete(manifestPath);
					if (stage == 1) { pending = manifestPath + ".pending"; expected = manifestBytes; }
					else { File.Delete(packPath); pending = packPath + ".pending"; expected = packBytes; }
				}
				using (var output = File.Create(pending)) output.Write(expected, 0, expected.Length / 2);
				Require(command(compact).Contains("\"compacted\":1"), "Truncated publication staging could not resume at stage " + stage);
				Require(!File.Exists(pending) && DirectoryBytes(root) == physicalBytes, "Staging retry left duplicate physical bytes at stage " + stage);
				Require(BytesEqual(original, (byte[])read.Invoke(null, new object[] { root, session, "snapshot-0001" })) && BytesEqual(packBytes, File.ReadAllBytes(packPath)), "Staging retry changed historical bytes or the retained pack.");
			}
			// Conflicting bytes are not an interrupted prefix and must remain untouched.
			File.WriteAllBytes(capture, original);
			string conflict = Path.Combine(root, session, "snapshot-0001.storage-pending");
			File.WriteAllBytes(conflict, new byte[] { 0 });
			Require(command(compact).Contains("\"success\":false") && BytesEqual(original, File.ReadAllBytes(capture)) && BytesEqual(new byte[] { 0 }, File.ReadAllBytes(conflict)), "Conflicting staging was replaced or the raw capture was lost.");
			File.Delete(conflict);
			Require(command(compact).Contains("\"compacted\":1") && DirectoryBytes(root) == physicalBytes, "Owned fixture did not recover after the conflict was removed.");
		}

		private static byte[] StorageFixture(string root, string session, string marker)
		{
			string directory = Path.Combine(root, session); Directory.CreateDirectory(directory);
			File.WriteAllText(Path.Combine(directory, "session.json"), "{\"version\":1,\"id\":\"" + session + "\",\"endedUtc\":\"2026-01-01T00:00:00Z\",\"snapshotCount\":1}");
			var json = new StringBuilder("{\"version\":1,\"id\":\"snapshot-0001\",\"sessionId\":\"" + session + "\",\"fixture\":\"");
			for (int index = 0; index < 6000; index++) json.Append(marker).Append("木é ");
			json.Append("\",\"objects\":[{\"instanceId\":2,\"name\":\"first\",\"position\":{\"x\":-0.0,\"y\":1e-7,\"z\":1.2500},\"components\":[{\"referencesTruncated\":true,\"references\":[{\"state\":\"unassigned\",\"instanceId\":0}]}]},{\"instanceId\":1,\"name\":\"second\"}],\"truncated\":true,\"truncationReason\":\"fixture_limit\"}");
			byte[] bytes = new UTF8Encoding(false).GetBytes(json.ToString()); File.WriteAllBytes(Path.Combine(directory, "snapshot-0001.json"), bytes); return bytes;
		}
		private static bool BytesEqual(byte[] first, byte[] second)
		{
			if (first.Length != second.Length) return false;
			for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) return false;
			return true;
		}
		private static long DirectoryBytes(string root)
		{
			long total = 0; foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) total += new FileInfo(file).Length; return total;
		}
		[Serializable] private sealed class StorageManifest { public int decodedBytes; public List<StorageBlock> blocks; }
		[Serializable] private sealed class StorageBlock { public string pack, sha256; public long offset; }

		private static void ValidateCaughtErrorCorrelation(Assembly assembly, Type builder, object snapshot, PlaySessionSnapshotProbe probe)
		{
			Type errorType = assembly.GetType("UnityCursorToolkit.PlaySessionError", true);
			string owner = typeof(PlaySessionSnapshotProbe).FullName;
			string[] messages =
			{
				"Something went wrong while executing a button event\nSystem.NullReferenceException: fixture\n  at " + owner + ".Execute () [0x00000] in Fixture.cs:1",
				"UnityEngine.UnassignedReferenceException: The variable unassigned of PlaySessionSnapshotProbe has not been assigned.",
				"UnassignedReferenceException: The variable unassigned of " + owner + " has not been assigned.",
				"OtherException: The variable unassigned of PlaySessionSnapshotProbe has not been assigned.",
				new string('x', 2048) + "\n  at " + owner + ".Execute ()"
			};
			for (int i = 0; i < messages.Length; i++)
			{
				object error = Activator.CreateInstance(errorType, true);
				errorType.GetField("message").SetValue(error, messages[i]);
				errorType.GetField("stackTrace").SetValue(error, "UnityEngine.Debug.LogError (System.Object)");
				snapshot.GetType().GetField("error").SetValue(snapshot, error);
				var components = (IList)snapshot.GetType().GetField("candidateComponentIds").GetValue(snapshot);
				components.Clear(); ((IList)snapshot.GetType().GetField("candidateObjectIds").GetValue(snapshot)).Clear();
				builder.GetMethod("Correlate", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new[] { snapshot });
				Require(components.Contains(probe.GetInstanceID()) == (i < 3), "Caught error/header correlation or its bounded exact syntax failed for case " + i);
				Require((int)snapshot.GetType().GetField("contextInstanceId").GetValue(snapshot) == 0 && !(bool)snapshot.GetType().GetField("contextPrioritized").GetValue(snapshot), "A type candidate was promoted to exact context.");
			}
			object contextless = JsonUtility.FromJson("{\"error\":{\"message\":\"fixture\"},\"objects\":[{\"instanceId\":71,\"components\":[{\"instanceId\":0,\"missingScript\":true}]}],\"candidateObjectIds\":[],\"candidateComponentIds\":[],\"consoleMatches\":[]}", snapshot.GetType());
			builder.GetMethod("Correlate", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new[] { contextless });
			Require((int)contextless.GetType().GetField("contextObjectInstanceId").GetValue(contextless) == 0, "A missing-script zero ID fabricated a context owner.");
		}

		private static void ValidatePriorityBudget(Type builder, Scene scene, GameObject owner, PlaySessionSnapshotProbe probe)
		{
			var filler = new GameObject("Priority budget fixture");
			SceneManager.MoveGameObjectToScene(filler, scene);
			Light ownerLight = null;
			try
			{
				filler.transform.SetAsFirstSibling(); owner.transform.SetAsLastSibling();
				string name = new string('p', 8192);
				for (int i = 0; i < 1100; i++)
				{
					var child = new GameObject(name); child.transform.SetParent(filler.transform, false);
					if (i < 96) child.AddComponent<Light>().enabled = false;
				}
				ownerLight = owner.AddComponent<Light>(); ownerLight.enabled = false;
				Require(UnityEditorInternal.ComponentUtility.MoveComponentUp(ownerLight) && UnityEditorInternal.ComponentUtility.MoveComponentUp(ownerLight), "Could not place the lower-ranked fixture component before the probe.");
				MethodInfo capture = builder.GetMethod("Capture", BindingFlags.Static | BindingFlags.NonPublic);
				object baseline = capture.Invoke(null, new object[] { "play_20261106_120000_0123abcd", "snapshot-0001", "priority_budget_fixture", null });
				var before = JsonUtility.FromJson<Snapshot>(JsonUtility.ToJson(baseline));
				Require(before.truncated && before.objects.Find(row => row.instanceId == owner.GetInstanceID()) == null, "Priority fixture did not exhaust the normal byte budget before the target.");
				Type errorType = builder.Assembly.GetType("UnityCursorToolkit.PlaySessionError", true);
				object error = Activator.CreateInstance(errorType, true);
				errorType.GetField("message").SetValue(error, "Something went wrong while executing a button event\nUnityEngine.UnassignedReferenceException: The variable assigned of PlaySessionSnapshotProbe has not been assigned.\n  at UnityEngine.Transform.get_position ()\n  at " + typeof(PlaySessionSnapshotProbe).FullName + ".Execute ()\n  at UnityEngine.Light.get_intensity ()");
				errorType.GetField("stackTrace").SetValue(error, "UnityEngine.Debug.LogError (System.Object)");
				object prioritized = capture.Invoke(null, new[] { (object)"play_20261106_120000_0123abcd", "snapshot-0001", "priority_budget_fixture", error });
				var after = JsonUtility.FromJson<Snapshot>(JsonUtility.ToJson(prioritized));
				Row captured = Find(after.objects, owner.GetInstanceID());
				Require(after.truncated && after.objects[0].instanceId == owner.GetInstanceID() && captured.parentInstanceId == 0 && captured.siblingIndex == owner.transform.GetSiblingIndex(), "Matching owner was not captured first with original hierarchy metadata.");
				var candidates = (IList)prioritized.GetType().GetField("candidateComponentIds").GetValue(prioritized);
				Require(candidates.Contains(probe.GetInstanceID()) && !candidates.Contains(owner.transform.GetInstanceID()) && candidates.Count == 64 && (int)candidates[0] == probe.GetInstanceID(), "Universal Transform frames consumed candidate slots or hid the script owner.");
				var ids = new HashSet<int>(); foreach (Row row in after.objects) Require(ids.Add(row.instanceId), "Priority capture duplicated an object row.");
				object exact = Activator.CreateInstance(prioritized.GetType(), true);
				exact.GetType().GetField("contextInstanceId").SetValue(exact, filler.transform.GetInstanceID());
				var owners = (IList)builder.GetMethod("PriorityOwners", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null,
					new object[] { new List<GameObject> { filler, owner }, new Dictionary<string, int> { { typeof(PlaySessionSnapshotProbe).FullName, 0 } }, exact });
				Require(owners.Count == 2 && (Transform)owners[0] == filler.transform && (Transform)owners[1] == owner.transform &&
					(bool)exact.GetType().GetField("contextPrioritized").GetValue(exact), "A supplied exact nonzero Unity context owner did not precede type candidates.");
			}
			finally { if (ownerLight) Object.DestroyImmediate(ownerLight); Object.DestroyImmediate(filler); }
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
			public int instanceId, parentInstanceId, siblingIndex, childCount, sceneHandle, layer;
			public string tag;
			public Vector3 position, localPosition, localScale;
			public Quaternion rotation;
			public bool activeSelf, activeInHierarchy, componentsTruncated;
			public List<ComponentRow> components;
		}
		[Serializable] private sealed class ComponentRow { public int instanceId, slot; public string type; public bool hasEnabled, enabled, referencesTruncated; public List<Reference> references; }
		[Serializable] private sealed class Reference { public string propertyPath, state; public int instanceId; }
	}

}
