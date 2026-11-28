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
		private const int MaximumProjectStateLength = 512;
		private string commandName;
		private string destinationId;
		private string arguments = "{}";
		private AgentCommandRunSnapshot run;
		private Label projectState;

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
			RefreshProjectState();
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
				RefreshProjectState();
				Repaint();
			});
			rootVisualElement.Add(enableControls);
			var content = new ScrollView(ScrollViewMode.Vertical);
			content.style.flexGrow = 1;
			rootVisualElement.Add(content);
			projectState = new Label { name = "game-flow-project-state" };
			projectState.style.whiteSpace = WhiteSpace.Normal;
			content.Add(projectState);
			content.Add(new IMGUIContainer(DrawContent));
			RefreshProjectState();
		}

		private void RefreshProjectState()
		{
			var source = GameFlowProjectState.Source;
			bool visible = source != null && SessionState.GetBool(EnabledKey, false);
			string state = string.Empty;
			if (visible)
			{
				try { state = source(); }
				catch (Exception) { state = null; }

				if (string.IsNullOrWhiteSpace(state))
					state = "Project state unavailable.";
				else if (state.Length > MaximumProjectStateLength)
					state = state.Substring(0, MaximumProjectStateLength);
			}
			projectState.text = state;
			projectState.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
		}

		private void DrawContent()
		{
			if (SessionState.GetBool(EnabledKey, false))
				DrawCommands();
			DrawResult();
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
					destinationId = null;
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
			if (destinations.Count > 0)
			{
				var choices = new string[destinations.Count + 1];
				choices[0] = "Custom arguments";
				int selected = destinationId == null ? 1 : 0;
				for (int i = 0; i < destinations.Count; i++)
				{
					GameFlowDestination item = destinations[i];
					choices[i + 1] = item.Category + " / " + item.Label;
					if (!string.IsNullOrEmpty(item.UnavailableReason))
						choices[i + 1] += " (Unavailable)";
					if (item.Id == destinationId)
						selected = i + 1;
				}

				selected = EditorGUILayout.Popup("Destination", selected, choices);
				if (selected > 0)
				{
					GameFlowDestination item = destinations[selected - 1];
					destinationId = item.Id;
					if (string.IsNullOrEmpty(item.UnavailableReason))
						return item.ArgumentsJson;
					EditorGUILayout.HelpBox(item.UnavailableReason, MessageType.Info);
					return null;
				}
				destinationId = string.Empty;
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
