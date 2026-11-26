#if UNITY_EDITOR

using System;
using UnityCursorToolkit.Core;
using UnityEditor;
using UnityEngine;

namespace UnityCursorToolkit
{
	/// <summary>Controls capture consent and displays its latest report in this Editor.</summary>
	internal sealed class StaticCaptureWindow : EditorWindow
	{
		private string assemblyNames = "";
		private int maxFields = 1000;
		private int maxMilliseconds = 10;
		private Vector2 reportScroll;
		private int displayedRevision;

		[MenuItem("Tools/Unity Cursor Toolkit/Static Capture")]
		private static void Open()
		{
			GetWindow<StaticCaptureWindow>("Static Capture");
		}

		private void OnInspectorUpdate()
		{
			if (displayedRevision != StaticSnapshotter.Revision)
				Repaint();
		}

		private void OnGUI()
		{
			if (StaticSnapshotter.Enabled)
			{
				if (GUILayout.Button("Stop capture"))
					StaticSnapshotter.Disable();
			}
			else
			{
				assemblyNames = EditorGUILayout.TextField("Assembly names", assemblyNames);
				EditorGUILayout.LabelField("Exact names, separated by commas.", EditorStyles.wordWrappedMiniLabel);
				maxFields = EditorGUILayout.IntSlider("Field limit", maxFields, 1, 1000);
				maxMilliseconds = EditorGUILayout.IntSlider("Time limit (ms)", maxMilliseconds, 1, 100);
				using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(assemblyNames)))
				{
					if (GUILayout.Button("Start capture"))
					{
						string[] names = Array.ConvertAll(assemblyNames.Split(','), name => name.Trim());
						StaticSnapshotter.Configure(names, maxFields, maxMilliseconds);
					}
				}
			}

			StaticSnapshotter.Snapshot snapshot = StaticSnapshotter.Latest;
			displayedRevision = StaticSnapshotter.Revision;
			if (snapshot == null)
				return;

			if (!snapshot.complete)
				EditorGUILayout.HelpBox(Readable(snapshot.skippedReason), MessageType.Warning);
			else
				EditorGUILayout.LabelField("Latest snapshot", snapshot.fields.Count + " fields");

			StaticSnapshotter.Diff report = StaticSnapshotter.LatestDiff;
			if (report == null)
				return;

			EditorGUILayout.LabelField("Latest transition", ObjectNames.NicifyVariableName(report.transition));
			if (!report.complete)
			{
				EditorGUILayout.HelpBox(Readable(report.incompleteReason), MessageType.Info);
				return;
			}

			reportScroll = EditorGUILayout.BeginScrollView(reportScroll);
			foreach (StaticSnapshotter.Difference change in report.fields)
			{
				EditorGUILayout.LabelField(
					change.assembly + " / " + change.type + "." + change.field, EditorStyles.wordWrappedLabel);
				string outcome = Readable(change.classification);
				string reason = string.IsNullOrEmpty(change.afterUnreadableReason)
					? change.beforeUnreadableReason : change.afterUnreadableReason;
				EditorGUILayout.LabelField(string.IsNullOrEmpty(reason) ? outcome : outcome + " (" + Readable(reason) + ")");
			}
			EditorGUILayout.EndScrollView();
		}

		private static string Readable(string value) => ObjectNames.NicifyVariableName(value.Replace('_', ' '));
	}
}

#endif
