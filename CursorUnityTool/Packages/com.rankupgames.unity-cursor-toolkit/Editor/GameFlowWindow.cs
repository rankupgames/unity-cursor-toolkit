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
		private const string RunIdKey = "UnityCursorToolkit.GameFlow.RunId";
		[SerializeField] private string commandName;
		[SerializeField] private string destinationId;
		[SerializeField] private bool customArgumentsSelected;
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
				RefreshRun(run.RunId);
			Repaint();
		}

		private void OnEnable()
		{
			string runId = SessionState.GetString(RunIdKey, string.Empty);
			if (!string.IsNullOrEmpty(runId))
				RefreshRun(runId);

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
			if (selected < 0 && !string.IsNullOrEmpty(commandName))
			{
				selected = names.Length;
				Array.Resize(ref names, names.Length + 1);
				names[selected] = commandName + " (Unavailable)";
			}
			using (new EditorGUI.DisabledScope(IsRunning))
			{
				int index = EditorGUILayout.Popup("Command", Math.Max(0, selected), names);
				if (index == commands.Length)
					return;

				AgentCommandDescriptor command = commands[index];
				if (commandName != command.Name)
				{
					commandName = command.Name;
					destinationId = null;
					customArgumentsSelected = false;
					arguments = "{}";
				}

				if (!string.IsNullOrEmpty(command.Description))
					EditorGUILayout.LabelField(command.Description, EditorStyles.wordWrappedLabel);

				string runArguments = DrawArguments(command);
				bool changingMode = EditorApplication.isPlaying != EditorApplication.isPlayingOrWillChangePlaymode;
				bool ready = !changingMode && !EditorApplication.isCompiling && !EditorApplication.isUpdating &&
					EditorApplication.isPlaying == command.RequiresPlayMode;
				using (new EditorGUI.DisabledScope(!ready || runArguments == null))
				{
					if (GUILayout.Button("Run"))
						StartRun(runArguments);
				}
				if (!ready)
					EditorGUILayout.LabelField(command.RequiresPlayMode ? "Requires Play Mode." : "Requires Edit Mode.");
			}
		}

		private string DrawArguments(AgentCommandDescriptor command)
		{
			var destinations = command.FlowDestinations;
			if (destinations.Count > 0 || !string.IsNullOrEmpty(destinationId))
			{
				var choices = new string[destinations.Count + 1];
				choices[0] = "Custom arguments";
				int selected = !string.IsNullOrEmpty(destinationId) ? -1 : customArgumentsSelected ? 0 : 1;
				for (int i = 0; i < destinations.Count; i++)
				{
					GameFlowDestination item = destinations[i];
					choices[i + 1] = item.Category + " / " + item.Label;
					if (!string.IsNullOrEmpty(item.UnavailableReason))
						choices[i + 1] += " (Unavailable)";
					if (item.Id == destinationId)
						selected = i + 1;
				}

				if (selected < 0)
				{
					selected = choices.Length;
					Array.Resize(ref choices, choices.Length + 1);
					choices[selected] = destinationId + " (Unavailable)";
				}

				selected = EditorGUILayout.Popup("Destination", selected, choices);
				if (selected == destinations.Count + 1)
					return null;

				if (selected > 0)
				{
					GameFlowDestination item = destinations[selected - 1];
					destinationId = item.Id;
					customArgumentsSelected = false;
					if (string.IsNullOrEmpty(item.UnavailableReason))
						return item.ArgumentsJson;
					EditorGUILayout.HelpBox(item.UnavailableReason, MessageType.Info);
					return null;
				}
				destinationId = null;
				customArgumentsSelected = true;
			}

			EditorGUILayout.LabelField("Arguments (JSON)");
			arguments = EditorGUILayout.TextArea(arguments, GUILayout.MinHeight(52));
			return arguments;
		}

		private void DrawResult()
		{
			if (run == null)
				return;

			EditorGUILayout.LabelField(run.Status.ToString(), EditorStyles.boldLabel);
			if (!string.IsNullOrEmpty(run.Progress))
				EditorGUILayout.LabelField(run.Progress, EditorStyles.wordWrappedLabel);
			AgentCommandResult result = run.Result;
			if (!string.IsNullOrEmpty(result?.Message))
				EditorGUILayout.HelpBox(result.Message, result.Success ? MessageType.Info : MessageType.Warning);
			if (!string.IsNullOrEmpty(result?.DataJson))
				EditorGUILayout.SelectableLabel(result.DataJson, EditorStyles.wordWrappedLabel, GUILayout.MinHeight(64));

			if (IsRunning && GUILayout.Button("Cancel"))
				CancelRun();
		}

		private void StartRun(string runArguments)
		{
			run = AgentCommandRunner.Run(commandName, runArguments);
			SessionState.SetString(RunIdKey, run.RunId);
		}

		private void RefreshRun(string runId)
		{
			run = AgentCommandRunner.GetStatus(runId);
			if (string.IsNullOrEmpty(run.RunId))
			{
				SessionState.EraseString(RunIdKey);
				run = null;
			}
		}

		private void CancelRun()
		{
			if (IsRunning)
				run = AgentCommandRunner.Cancel(run.RunId);
		}

		private static bool IsFlowCommand(AgentCommandDescriptor command)
		{
			return command.FlowDestinations.Count > 0 ||
				command.Name.StartsWith("flow.", StringComparison.Ordinal) ||
				command.Name.IndexOf(".flow.", StringComparison.Ordinal) >= 0;
		}
	}
}
