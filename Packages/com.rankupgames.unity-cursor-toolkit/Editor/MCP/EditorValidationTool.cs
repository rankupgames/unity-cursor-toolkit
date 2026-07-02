// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handler for editor project file sync and script compile validation.
// Created: 2026-06-21
// Last Modified: 2026-06-21
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	/// <summary>
	/// Exposes project-file regeneration and script compilation requests to MCP clients.
	/// </summary>
	[InitializeOnLoad]
	[MCPTool("editor_validation")]
	internal sealed class EditorValidationTool : IToolHandler
	{
		/// <summary>
		/// Initializes compile callback tracking as soon as the editor assembly loads.
		/// </summary>
		static EditorValidationTool()
		{
			EditorValidationState.RegisterCallbacks();
		}

		/// <summary>
		/// Tool name used by MCP clients.
		/// </summary>
		public string ToolName
		{
			get
			{
				return "editor_validation";
			}
		}

		/// <summary>
		/// Human-readable tool description for local tool diagnostics.
		/// </summary>
		public string Description
		{
			get
			{
				return "Regenerate Unity project files, request script compilation, and poll compile status.";
			}
		}

		/// <summary>
		/// Regenerates project files and requests a compile from the Unity menu.
		/// </summary>
		[MenuItem("Tools/Unity Cursor Toolkit/Validation/Regenerate Project Files And Compile")]
		private static void RegenerateProjectFilesAndCompileFromMenu()
		{
			string result = EditorValidationState.SyncAndRequestCompile("menu");
			Debug.Log("(UnityCursorToolkit.EditorValidation) " + result);
		}

		/// <summary>
		/// Routes editor validation actions from MCP clients.
		/// </summary>
		/// <param name="argsJson">JSON string containing an optional action property.</param>
		/// <returns>JSON result for the requested editor validation action.</returns>
		public string HandleCommand(string argsJson)
		{
			string action = GameCommandToolJson.GetString(argsJson, "action", "sync_and_compile");
			switch (action)
			{
				case "list":
					return EditorValidationState.GetCatalogJson();
				case "status":
					return EditorValidationState.GetStatusJson();
				case "sync_project_files":
					return EditorValidationState.SyncProjectFilesOnly();
				case "request_compile":
				case "sync_and_compile":
					return EditorValidationState.SyncAndRequestCompile("mcp");
				default:
					return GameCommandToolJson.Error("Unknown editor_validation action: " + action);
			}
		}
	}

	/// <summary>
	/// Tracks the most recent editor validation request across asynchronous compile callbacks.
	/// </summary>
	internal static class EditorValidationState
	{
		/// <summary>
		/// SessionState key for the current validation status.
		/// </summary>
		private const string StatusKey = "UnityCursorToolkit.EditorValidation.Status";

		/// <summary>
		/// SessionState key for the current validation message.
		/// </summary>
		private const string MessageKey = "UnityCursorToolkit.EditorValidation.Message";

		/// <summary>
		/// SessionState key for the project-file sync path used by the current request.
		/// </summary>
		private const string SyncMethodKey = "UnityCursorToolkit.EditorValidation.SyncMethod";

		/// <summary>
		/// SessionState key marking that a toolkit-triggered compile is still pending.
		/// </summary>
		private const string PendingKey = "UnityCursorToolkit.EditorValidation.Pending";

		/// <summary>
		/// SessionState key marking that Unity started a compile for the current request.
		/// </summary>
		private const string CompilationStartedKey = "UnityCursorToolkit.EditorValidation.CompilationStarted";

		/// <summary>
		/// SessionState key for the current compiler error count.
		/// </summary>
		private const string ErrorCountKey = "UnityCursorToolkit.EditorValidation.ErrorCount";

		/// <summary>
		/// SessionState key for the current compiler warning count.
		/// </summary>
		private const string WarningCountKey = "UnityCursorToolkit.EditorValidation.WarningCount";

		/// <summary>
		/// SessionState key for the UTC request timestamp.
		/// </summary>
		private const string RequestedUtcKey = "UnityCursorToolkit.EditorValidation.RequestedUtc";

		/// <summary>
		/// SessionState key for the UTC completion timestamp.
		/// </summary>
		private const string FinishedUtcKey = "UnityCursorToolkit.EditorValidation.FinishedUtc";

		/// <summary>
		/// SessionState key for the no-compile timeout stored as editor time.
		/// </summary>
		private const string CompileTimeoutAtKey = "UnityCursorToolkit.EditorValidation.CompileTimeoutAt";

		/// <summary>
		/// Relative path for the pollable validation result file.
		/// </summary>
		private const string ResultPathRelative = "TestResults/UnityCursorToolkit/EditorValidation/latest.json";

		/// <summary>
		/// Seconds to wait before treating a compile request that did not start as a sync-only success.
		/// </summary>
		private const double NoCompileStartTimeoutSeconds = 4.0d;

		/// <summary>
		/// Registers compile callbacks once per editor domain load.
		/// </summary>
		internal static void RegisterCallbacks()
		{
			CompilationPipeline.compilationStarted -= OnCompilationStarted;
			CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
			CompilationPipeline.compilationFinished -= OnCompilationFinished;
			CompilationPipeline.compilationStarted += OnCompilationStarted;
			CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
			CompilationPipeline.compilationFinished += OnCompilationFinished;
			EditorApplication.update -= PollCompileStartTimeout;
			EditorApplication.update += PollCompileStartTimeout;
		}

		/// <summary>
		/// Describes supported actions for callers that surface tool help.
		/// </summary>
		/// <returns>JSON catalog for editor validation actions.</returns>
		internal static string GetCatalogJson()
		{
			return "{\"success\":true,\"tool\":\"editor_validation\",\"actions\":[\"list\",\"status\",\"sync_project_files\",\"request_compile\",\"sync_and_compile\"],\"resultPath\":\"" + EditorControlHelpers.Escape(GetResultPath()) + "\"}";
		}

		/// <summary>
		/// Synchronizes Unity project files without requesting a script compile.
		/// </summary>
		/// <returns>JSON status after project-file synchronization.</returns>
		internal static string SyncProjectFilesOnly()
		{
			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				SetCompletedStatus("blocked", "Exit play mode before regenerating project files.", GetSyncMethod(), false);
				return GetStatusJson();
			}

			AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
			string syncMethod = SynchronizeProjectFiles();
			SetCompletedStatus("succeeded", "Project files synchronized.", syncMethod, true);
			return GetStatusJson();
		}

		/// <summary>
		/// Synchronizes project files and asks Unity to compile scripts on the main editor thread.
		/// </summary>
		/// <param name="trigger">Short source label for diagnostics.</param>
		/// <returns>JSON status after the compile request is accepted or rejected.</returns>
		internal static string SyncAndRequestCompile(string trigger)
		{
			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				SetCompletedStatus("blocked", "Exit play mode before requesting script compilation.", GetSyncMethod(), false);
				return GetStatusJson();
			}

			if (EditorApplication.isCompiling)
			{
				SetRunningStatus("compiling", "Unity is already compiling. Poll editor_validation status for the result.", GetSyncMethod());
				return GetStatusJson();
			}

			AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
			string syncMethod = SynchronizeProjectFiles();
			SetRunningStatus("running", "Project files synchronized and script compilation requested by " + trigger + ".", syncMethod);
			CompilationPipeline.RequestScriptCompilation();
			SessionState.SetString(CompileTimeoutAtKey, (EditorApplication.timeSinceStartup + NoCompileStartTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			EditorApplication.update -= PollCompileStartTimeout;
			EditorApplication.update += PollCompileStartTimeout;
			return GetStatusJson();
		}

		/// <summary>
		/// Returns the last known validation status and updates transient compile state first.
		/// </summary>
		/// <returns>JSON status for the current or most recent validation request.</returns>
		internal static string GetStatusJson()
		{
			UpdateTransientCompileStatus();
			string status = GetStatus();
			bool success = status != "failed" && status != "blocked";
			return BuildStatusJson(success);
		}

		/// <summary>
		/// Notes that a compile for the pending request has started.
		/// </summary>
		/// <param name="context">Unity compile context object.</param>
		private static void OnCompilationStarted(object context)
		{
			if (SessionState.GetBool(PendingKey, false) == false)
			{
				return;
			}

			SessionState.SetBool(CompilationStartedKey, true);
			SessionState.SetString(StatusKey, "compiling");
			SessionState.SetString(MessageKey, "Script compilation started.");
			SessionState.SetInt(ErrorCountKey, 0);
			SessionState.SetInt(WarningCountKey, 0);
			WriteCurrentResult(true);
		}

		/// <summary>
		/// Aggregates compiler diagnostics for assemblies compiled by the pending request.
		/// </summary>
		/// <param name="assemblyPath">Compiled assembly path.</param>
		/// <param name="messages">Compiler diagnostics emitted for the assembly.</param>
		private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
		{
			if (SessionState.GetBool(PendingKey, false) == false || messages == null)
			{
				return;
			}

			int errorCount = SessionState.GetInt(ErrorCountKey, 0);
			int warningCount = SessionState.GetInt(WarningCountKey, 0);
			for (int index = 0; index < messages.Length; index++)
			{
				CompilerMessage message = messages[index];
				if (message.type == CompilerMessageType.Error)
				{
					errorCount++;
				}
				else if (message.type == CompilerMessageType.Warning)
				{
					warningCount++;
				}
			}

			SessionState.SetInt(ErrorCountKey, errorCount);
			SessionState.SetInt(WarningCountKey, warningCount);
		}

		/// <summary>
		/// Completes the pending request when Unity finishes script compilation.
		/// </summary>
		/// <param name="context">Unity compile context object.</param>
		private static void OnCompilationFinished(object context)
		{
			if (SessionState.GetBool(PendingKey, false) == false)
			{
				return;
			}

			int errorCount = SessionState.GetInt(ErrorCountKey, 0);
			if (errorCount > 0)
			{
				SetCompletedStatus("failed", "Script compilation finished with compiler errors.", GetSyncMethod(), false);
			}
			else
			{
				SetCompletedStatus("succeeded", "Script compilation finished successfully.", GetSyncMethod(), true);
			}
		}

		/// <summary>
		/// Completes a compile request when Unity accepts the request but no compile pass starts.
		/// </summary>
		private static void PollCompileStartTimeout()
		{
			if (SessionState.GetBool(PendingKey, false) == false)
			{
				EditorApplication.update -= PollCompileStartTimeout;
				return;
			}

			if (SessionState.GetBool(CompilationStartedKey, false) || EditorApplication.isCompiling)
			{
				return;
			}

			double timeoutAt = ReadEditorTime(CompileTimeoutAtKey);
			if (timeoutAt <= 0.0d || EditorApplication.timeSinceStartup < timeoutAt)
			{
				return;
			}

			SetCompletedStatus("succeeded", "Project files synchronized. Unity did not start a script compilation pass.", GetSyncMethod(), true);
			EditorApplication.update -= PollCompileStartTimeout;
		}

		/// <summary>
		/// Keeps status truthful when callers poll while Unity is compiling.
		/// </summary>
		private static void UpdateTransientCompileStatus()
		{
			if (SessionState.GetBool(PendingKey, false) == false)
			{
				return;
			}

			if (EditorApplication.isCompiling)
			{
				SessionState.SetString(StatusKey, "compiling");
				SessionState.SetString(MessageKey, "Script compilation is running.");
			}
		}

		/// <summary>
		/// Marks a validation request as running and initializes diagnostics.
		/// </summary>
		/// <param name="status">Running status label.</param>
		/// <param name="message">Human-readable status message.</param>
		/// <param name="syncMethod">Project-file sync method used for the request.</param>
		private static void SetRunningStatus(string status, string message, string syncMethod)
		{
			SessionState.SetBool(PendingKey, true);
			SessionState.SetBool(CompilationStartedKey, false);
			SessionState.SetString(StatusKey, status);
			SessionState.SetString(MessageKey, message);
			SessionState.SetString(SyncMethodKey, syncMethod);
			SessionState.SetString(RequestedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			SessionState.SetString(FinishedUtcKey, string.Empty);
			SessionState.SetInt(ErrorCountKey, 0);
			SessionState.SetInt(WarningCountKey, 0);
			WriteCurrentResult(true);
		}

		/// <summary>
		/// Marks a validation request as completed and writes the pollable result.
		/// </summary>
		/// <param name="status">Final status label.</param>
		/// <param name="message">Human-readable final message.</param>
		/// <param name="syncMethod">Project-file sync method used for the request.</param>
		/// <param name="success">Whether the request completed successfully.</param>
		private static void SetCompletedStatus(string status, string message, string syncMethod, bool success)
		{
			SessionState.SetBool(PendingKey, false);
			SessionState.SetBool(CompilationStartedKey, false);
			SessionState.SetString(StatusKey, status);
			SessionState.SetString(MessageKey, message);
			SessionState.SetString(SyncMethodKey, syncMethod);
			if (string.IsNullOrEmpty(SessionState.GetString(RequestedUtcKey, string.Empty)))
			{
				SessionState.SetString(RequestedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			}

			SessionState.SetString(FinishedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			WriteCurrentResult(success);
		}

		/// <summary>
		/// Synchronizes project files using the current code editor integration when available.
		/// </summary>
		/// <returns>Name of the synchronization path that ran.</returns>
		private static string SynchronizeProjectFiles()
		{
			string codeEditorSync = SynchronizeWithCurrentCodeEditor();
			if (string.IsNullOrEmpty(codeEditorSync) == false)
			{
				return codeEditorSync;
			}

			string syncVs = InvokeStaticUnityMethod("UnityEditor.SyncVS", "SyncSolution");
			if (string.IsNullOrEmpty(syncVs) == false)
			{
				return syncVs;
			}

			return "unavailable";
		}

		/// <summary>
		/// Invokes Unity's active external code editor project sync without taking a compile-time package dependency.
		/// </summary>
		/// <returns>Name of the synchronization method, or an empty string when unavailable.</returns>
		private static string SynchronizeWithCurrentCodeEditor()
		{
			Type codeEditorType = FindType("Unity.CodeEditor.CodeEditor");
			if (codeEditorType == null)
			{
				return string.Empty;
			}

			PropertyInfo currentEditorProperty = codeEditorType.GetProperty("CurrentEditor", BindingFlags.Public | BindingFlags.Static);
			if (currentEditorProperty == null)
			{
				return string.Empty;
			}

			object currentEditor = currentEditorProperty.GetValue(null, null);
			if (currentEditor == null)
			{
				return string.Empty;
			}

			MethodInfo syncAllMethod = currentEditor.GetType().GetMethod("SyncAll", BindingFlags.Public | BindingFlags.Instance);
			if (syncAllMethod == null)
			{
				return string.Empty;
			}

			syncAllMethod.Invoke(currentEditor, null);
			return "Unity.CodeEditor.CodeEditor.CurrentEditor.SyncAll";
		}

		/// <summary>
		/// Invokes a static Unity editor method by reflection when it exists.
		/// </summary>
		/// <param name="typeName">Full type name containing the static method.</param>
		/// <param name="methodName">Static method name to invoke.</param>
		/// <returns>Name of the invoked method, or an empty string when unavailable.</returns>
		private static string InvokeStaticUnityMethod(string typeName, string methodName)
		{
			Type type = FindType(typeName);
			if (type == null)
			{
				return string.Empty;
			}

			MethodInfo method = type.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
			if (method == null)
			{
				return string.Empty;
			}

			method.Invoke(null, null);
			return typeName + "." + methodName;
		}

		/// <summary>
		/// Finds an editor type across loaded assemblies without requiring a direct assembly reference.
		/// </summary>
		/// <param name="typeName">Full type name to locate.</param>
		/// <returns>Matching type or null.</returns>
		private static Type FindType(string typeName)
		{
			Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
			for (int index = 0; index < assemblies.Length; index++)
			{
				Type type = assemblies[index].GetType(typeName);
				if (type != null)
				{
					return type;
				}
			}

			return null;
		}

		/// <summary>
		/// Writes the current status JSON to the deterministic result path.
		/// </summary>
		/// <param name="success">Whether the current status should be treated as successful by MCP clients.</param>
		private static void WriteCurrentResult(bool success)
		{
			string resultPath = GetResultPath();
			Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
			File.WriteAllText(resultPath, BuildStatusJson(success));
		}

		/// <summary>
		/// Builds a JSON status object for MCP clients and file polling.
		/// </summary>
		/// <param name="success">Whether the current status should be treated as successful by MCP clients.</param>
		/// <returns>Escaped JSON status object.</returns>
		private static string BuildStatusJson(bool success)
		{
			return "{\"success\":" + ToJsonBool(success) +
				",\"tool\":\"editor_validation\"" +
				",\"status\":\"" + EditorControlHelpers.Escape(GetStatus()) + "\"" +
				",\"message\":\"" + EditorControlHelpers.Escape(SessionState.GetString(MessageKey, "No editor validation has run in this session.")) + "\"" +
				",\"pending\":" + ToJsonBool(SessionState.GetBool(PendingKey, false)) +
				",\"isCompiling\":" + ToJsonBool(EditorApplication.isCompiling) +
				",\"syncMethod\":\"" + EditorControlHelpers.Escape(GetSyncMethod()) + "\"" +
				",\"errorCount\":" + SessionState.GetInt(ErrorCountKey, 0).ToString(CultureInfo.InvariantCulture) +
				",\"warningCount\":" + SessionState.GetInt(WarningCountKey, 0).ToString(CultureInfo.InvariantCulture) +
				",\"requestedUtc\":\"" + EditorControlHelpers.Escape(SessionState.GetString(RequestedUtcKey, string.Empty)) + "\"" +
				",\"finishedUtc\":\"" + EditorControlHelpers.Escape(SessionState.GetString(FinishedUtcKey, string.Empty)) + "\"" +
				",\"resultPath\":\"" + EditorControlHelpers.Escape(GetResultPath()) + "\"}";
		}

		/// <summary>
		/// Reads the current status label.
		/// </summary>
		/// <returns>Current status label.</returns>
		private static string GetStatus()
		{
			return SessionState.GetString(StatusKey, "idle");
		}

		/// <summary>
		/// Reads the current project-file sync method label.
		/// </summary>
		/// <returns>Current project-file sync method label.</returns>
		private static string GetSyncMethod()
		{
			return SessionState.GetString(SyncMethodKey, string.Empty);
		}

		/// <summary>
		/// Resolves the deterministic validation result file path under the Unity project.
		/// </summary>
		/// <returns>Absolute path to the validation result file.</returns>
		private static string GetResultPath()
		{
			string projectRoot = Directory.GetParent(Application.dataPath).FullName;
			return Path.Combine(projectRoot, ResultPathRelative);
		}

		/// <summary>
		/// Reads an editor-time value from SessionState.
		/// </summary>
		/// <param name="key">SessionState key containing a double value.</param>
		/// <returns>Parsed editor-time value, or zero when missing.</returns>
		private static double ReadEditorTime(string key)
		{
			string rawValue = SessionState.GetString(key, string.Empty);
			if (string.IsNullOrEmpty(rawValue))
			{
				return 0.0d;
			}

			double parsed;
			if (double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) == false)
			{
				return 0.0d;
			}

			return parsed;
		}

		/// <summary>
		/// Converts a bool into a JSON literal.
		/// </summary>
		/// <param name="value">Value to convert.</param>
		/// <returns>JSON bool literal.</returns>
		private static string ToJsonBool(bool value)
		{
			return value ? "true" : "false";
		}
	}
}

#endif
