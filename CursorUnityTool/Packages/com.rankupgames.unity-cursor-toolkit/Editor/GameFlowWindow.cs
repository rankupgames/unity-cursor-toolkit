using System;
using UnityCursorToolkit.AgentCommands;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace UnityCursorToolkit
{
	internal sealed class GameFlowWindow : EditorWindow
	{
		private const string EnabledKey = "UnityCursorToolkit.GameFlow.Enabled";
		private string commandName;
		private string arguments = "{}";
		private AgentCommandRunSnapshot run;
		private Vector2 scrollPosition;

		private bool IsRunning => run != null &&
			(run.Status == AgentCommandStatus.Pending || run.Status == AgentCommandStatus.Running);

		[MenuItem("Tools/Unity Cursor Toolkit/Game Flow")]
		private static void Open()
		{
			GetWindow<GameFlowWindow>("Game Flow");
		}

		private void OnInspectorUpdate()
		{
			if (IsRunning)
				run = AgentCommandRunner.GetStatus(run.RunId);
			Repaint();
		}

		private void OnEnable()
		{
			var enableControls = new Toggle("Enable Game Flow controls") { name = "game-flow-enabled" };
			enableControls.SetValueWithoutNotify(SessionState.GetBool(EnabledKey, false));
			enableControls.RegisterValueChangedCallback(change =>
			{
				SessionState.SetBool(EnabledKey, change.newValue);
				if (!change.newValue)
					CancelRun();
				Repaint();
			});
			rootVisualElement.Add(enableControls);
			var commands = new IMGUIContainer(DrawContent);
			commands.style.flexGrow = 1;
			rootVisualElement.Add(commands);
		}

		private void DrawContent()
		{
			scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);
			if (SessionState.GetBool(EnabledKey, false))
				DrawCommands();
			DrawResult();
			EditorGUILayout.EndScrollView();
		}

		private void DrawCommands()
		{
			AgentCommandDescriptor[] commands = Array.FindAll(AgentCommandRegistry.GetCommands(), IsFlowCommand);
			if (commands.Length == 0)
			{
				EditorGUILayout.LabelField("No Game Flow commands are registered.");
				return;
			}

			int selected = Array.FindIndex(commands, command => command.Name == commandName);
			string[] names = Array.ConvertAll(commands, command => command.Name);
			using (new EditorGUI.DisabledScope(IsRunning))
			{
				int index = EditorGUILayout.Popup("Command", Math.Max(0, selected), names);
				AgentCommandDescriptor command = commands[index];
				if (commandName != command.Name)
				{
					commandName = command.Name;
					arguments = "{}";
				}

				if (!string.IsNullOrEmpty(command.Description))
					EditorGUILayout.LabelField(command.Description, EditorStyles.wordWrappedLabel);

				EditorGUILayout.LabelField("Arguments (JSON)");
				arguments = EditorGUILayout.TextArea(arguments, GUILayout.MinHeight(52));
				bool changingMode = EditorApplication.isPlaying != EditorApplication.isPlayingOrWillChangePlaymode;
				bool ready = !changingMode && !EditorApplication.isCompiling && !EditorApplication.isUpdating &&
					EditorApplication.isPlaying == command.RequiresPlayMode;
				using (new EditorGUI.DisabledScope(!ready))
				{
					if (GUILayout.Button("Run"))
						run = AgentCommandRunner.Run(commandName, arguments);
				}
				if (!ready)
					EditorGUILayout.LabelField(command.RequiresPlayMode ? "Requires Play Mode." : "Requires Edit Mode.");
			}
		}

		private void DrawResult()
		{
			if (run == null)
				return;

			EditorGUILayout.LabelField(run.Status.ToString(), EditorStyles.boldLabel);
			AgentCommandResult result = run.Result;
			if (!string.IsNullOrEmpty(result?.Message))
				EditorGUILayout.HelpBox(result.Message, result.Success ? MessageType.Info : MessageType.Warning);
			if (!string.IsNullOrEmpty(result?.DataJson))
				EditorGUILayout.SelectableLabel(result.DataJson, EditorStyles.wordWrappedLabel, GUILayout.MinHeight(64));

			if (IsRunning && GUILayout.Button("Cancel"))
				CancelRun();
		}

		private void CancelRun()
		{
			if (IsRunning)
				run = AgentCommandRunner.Cancel(run.RunId);
		}

		private static bool IsFlowCommand(AgentCommandDescriptor command)
		{
			return command.Name.StartsWith("flow.", StringComparison.Ordinal) ||
				command.Name.IndexOf(".flow.", StringComparison.Ordinal) >= 0;
		}
	}
}
