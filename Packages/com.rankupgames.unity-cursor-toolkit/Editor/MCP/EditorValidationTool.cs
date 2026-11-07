// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handler for editor project file sync and script compile validation.
// Created: 2026-06-21
// Last Modified: 2026-07-10
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using SystemAssembly = System.Reflection.Assembly;
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
			if (EditorValidationState.IsAssetImportWorker) return GameCommandToolJson.Error("unsupported_process: editor validation is unavailable in an asset import worker.");
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
					return EditorValidationState.RequestCompileOnly("mcp");
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
		/// Seconds to wait before reporting a request with no observed compile pass as inconclusive.
		/// </summary>
		private const double NoCompileStartTimeoutSeconds = 4.0d;
		private const double ReloadTimeoutSeconds = 60.0d;
		private const string RequestIdKey = "UnityCursorToolkit.EditorValidation.RequestId";
		private const string RequestOwnerPidKey = "UnityCursorToolkit.EditorValidation.RequestOwnerPid";
		private const string OperationKey = "UnityCursorToolkit.EditorValidation.Operation";
		private const string CompilationFinishedKey = "UnityCursorToolkit.EditorValidation.CompilationFinished";
		private const string CompileSucceededKey = "UnityCursorToolkit.EditorValidation.CompileSucceeded";
		private const string SyncSucceededKey = "UnityCursorToolkit.EditorValidation.SyncSucceeded";
		private const string DiagnosticsCompleteKey = "UnityCursorToolkit.EditorValidation.DiagnosticsComplete";
		private const string ReloadPendingKey = "UnityCursorToolkit.EditorValidation.ReloadPending";
		private const string CompileFinishedDomainKey = "UnityCursorToolkit.EditorValidation.CompileFinishedDomain";
		private const string ReloadTimeoutAtKey = "UnityCursorToolkit.EditorValidation.ReloadTimeoutAt";

		internal static readonly string DomainId = Guid.NewGuid().ToString("N");
		internal static string MainThreadObservedUtc { get; private set; } = string.Empty;
		internal static readonly int EditorPid = ReadEditorPid();
		internal static string ProjectPath => Directory.GetParent(Application.dataPath).FullName;

		// Import workers load editor assemblies but do not own validation requests or their result file.
		internal static bool IsAssetImportWorker
		{
			get
			{
#if UNITY_2020_2_OR_NEWER
				return AssetDatabase.IsAssetImportWorkerProcess();
#else
				return false;
#endif
			}
		}

		private static bool OwnsRequest => SessionState.GetInt(RequestOwnerPidKey, 0) == EditorPid &&
			!string.IsNullOrEmpty(SessionState.GetString(RequestIdKey, string.Empty));

		/// <summary>
		/// Registers compile callbacks once per editor domain load.
		/// </summary>
		internal static void RegisterCallbacks()
		{
			if (IsAssetImportWorker) return;
			CompilationPipeline.compilationStarted -= OnCompilationStarted;
			CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
			CompilationPipeline.compilationFinished -= OnCompilationFinished;
			CompilationPipeline.compilationStarted += OnCompilationStarted;
			CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
			CompilationPipeline.compilationFinished += OnCompilationFinished;
			AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeAssemblyReload;
			AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
			EditorApplication.delayCall -= ObserveMainThread;
			EditorApplication.delayCall += ObserveMainThread;
			EditorApplication.update -= PollCompileStartTimeout;
			if (SessionState.GetBool(PendingKey, false) || SessionState.GetBool(ReloadPendingKey, false))
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
			if (IsAssetImportWorker) return GameCommandToolJson.Error("unsupported_process: editor validation is unavailable in an asset import worker.");
			if (SessionState.GetBool(PendingKey, false)) return GetStatusJson();
			ResetRequestState();
			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				SetCompletedStatus("blocked", "Exit play mode before regenerating project files.", GetSyncMethod(), false);
				return GetStatusJson();
			}

			if (EditorApplication.isCompiling || EditorApplication.isUpdating)
			{
				SetCompletedStatus("blocked", "Unity is compiling or importing assets. Retry project-file synchronization when the editor is idle.", GetSyncMethod(), false);
				return GetStatusJson();
			}

			SessionState.SetString(OperationKey, "sync_project_files");
			string syncMethod = SynchronizeProjectFiles();
			if (string.IsNullOrEmpty(syncMethod))
			{
				SetCompletedStatus("failed", "Unity project-file synchronization is unavailable.", string.Empty, false);
				return GetStatusJson();
			}

			SessionState.SetBool(SyncSucceededKey, true);
			SessionState.SetString(SyncMethodKey, syncMethod);
			if (SessionState.GetBool(PendingKey, false)) return GetStatusJson();
			SetCompletedStatus("succeeded", "Project files synchronized; script compilation was not requested.", syncMethod, true);
			return GetStatusJson();
		}

		/// <summary>
		/// Requests script compilation without regenerating project files.
		/// </summary>
		/// <param name="trigger">Short source label for diagnostics.</param>
		/// <returns>JSON status after the compile request is accepted or rejected.</returns>
		internal static string RequestCompileOnly(string trigger)
		{
			if (IsAssetImportWorker) return GameCommandToolJson.Error("unsupported_process: editor validation is unavailable in an asset import worker.");
			if (SessionState.GetBool(PendingKey, false)) return GetStatusJson();
			ResetRequestState();
			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				SetCompletedStatus("blocked", "Exit play mode before requesting script compilation.", "not_requested", false);
				return GetStatusJson();
			}

			if (EditorApplication.isCompiling)
			{
				BeginObservedCompilation(false);
				SessionState.SetString(SyncMethodKey, "existing_compile");
				return GetStatusJson();
			}

			RequestScriptCompilation(trigger, "not_requested");
			return GetStatusJson();
		}

		/// <summary>
		/// Synchronizes project files and asks Unity to compile scripts on the main editor thread.
		/// </summary>
		/// <param name="trigger">Short source label for diagnostics.</param>
		/// <returns>JSON status after the compile request is accepted or rejected.</returns>
		internal static string SyncAndRequestCompile(string trigger)
		{
			if (IsAssetImportWorker) return GameCommandToolJson.Error("unsupported_process: editor validation is unavailable in an asset import worker.");
			if (SessionState.GetBool(PendingKey, false)) return GetStatusJson();
			ResetRequestState();
			if (EditorApplication.isPlayingOrWillChangePlaymode)
			{
				SetCompletedStatus("blocked", "Exit play mode before requesting script compilation.", GetSyncMethod(), false);
				return GetStatusJson();
			}

			if (EditorApplication.isCompiling)
			{
				BeginObservedCompilation(false);
				SessionState.SetString(SyncMethodKey, "existing_compile");
				return GetStatusJson();
			}

			if (EditorApplication.isUpdating)
			{
				SetCompletedStatus("blocked", "Unity is importing assets. Retry sync_and_compile when the editor is idle.", "existing_import", false);
				return GetStatusJson();
			}

			SessionState.SetString(OperationKey, "sync_and_compile");
			string syncMethod = SynchronizeProjectFiles();
			if (string.IsNullOrEmpty(syncMethod))
			{
				SetCompletedStatus("failed", "Unity project-file synchronization is unavailable; script compilation was not requested.", string.Empty, false);
				return GetStatusJson();
			}

			SessionState.SetBool(SyncSucceededKey, true);
			TrackRefreshCompilation(trigger, syncMethod);
			try
			{
				AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
			}
			catch (Exception exception)
			{
				SetCompletedStatus("failed", "Unity asset refresh failed: " + exception.Message, syncMethod, false);
			}

			return GetStatusJson();
		}

		/// <summary>
		/// Tracks compilation caused by an asset refresh without requesting a redundant second compile pass.
		/// </summary>
		/// <param name="trigger">Short source label for diagnostics.</param>
		/// <param name="syncMethod">Project-file synchronization method used for the request.</param>
		private static void TrackRefreshCompilation(string trigger, string syncMethod)
		{
			SetRunningStatus("running", "Project files synchronized and changed scripts are being imported for " + trigger + ".", syncMethod);
			SessionState.SetString(CompileTimeoutAtKey, (EditorApplication.timeSinceStartup + NoCompileStartTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			EditorApplication.update -= PollCompileStartTimeout;
			EditorApplication.update += PollCompileStartTimeout;
		}

		/// <summary>
		/// Starts an asynchronous script compilation request and schedules no-compile detection.
		/// </summary>
		/// <param name="trigger">Short source label for diagnostics.</param>
		/// <param name="syncMethod">Project-file synchronization method, or not_requested.</param>
		private static void RequestScriptCompilation(string trigger, string syncMethod)
		{
			string message = syncMethod == "not_requested"
				? "Script compilation requested by " + trigger + "."
				: "Project files synchronized and script compilation requested by " + trigger + ".";
			SessionState.SetString(OperationKey, "request_compile");
			SetRunningStatus("running", message, syncMethod);
			CompilationPipeline.RequestScriptCompilation();
			SessionState.SetString(CompileTimeoutAtKey, (EditorApplication.timeSinceStartup + NoCompileStartTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			EditorApplication.update -= PollCompileStartTimeout;
			EditorApplication.update += PollCompileStartTimeout;
		}

		/// <summary>
		/// Returns the last known validation status and updates transient compile state first.
		/// </summary>
		/// <returns>JSON status for the current or most recent validation request.</returns>
		internal static string GetStatusJson()
		{
			if (IsAssetImportWorker) return GameCommandToolJson.Error("unsupported_process: editor validation is unavailable in an asset import worker.");
			ObserveMainThread();
			UpdateTransientCompileStatus();
			return BuildStatusJson(true);
		}

		/// <summary>
		/// Notes that a compile for the pending request has started.
		/// </summary>
		/// <param name="context">Unity compile context object.</param>
		private static void OnCompilationStarted(object context)
		{
			if (IsAssetImportWorker) return;
			if (!SessionState.GetBool(PendingKey, false)) BeginObservedCompilation(true);
			else if (!SessionState.GetBool(CompilationStartedKey, false)) SessionState.SetBool(DiagnosticsCompleteKey, true);
			SessionState.SetBool(CompilationStartedKey, true);
			SessionState.SetBool(CompilationFinishedKey, false);
			SessionState.SetBool(CompileSucceededKey, false);
			SessionState.SetBool(ReloadPendingKey, false);
			SessionState.SetString(ReloadTimeoutAtKey, (EditorApplication.timeSinceStartup + ReloadTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			SessionState.SetString(StatusKey, "compiling");
			SessionState.SetString(MessageKey, "Script compilation started.");
			// Keep earlier errors if Unity schedules another pass for the same pending request.
			WriteCurrentResult(false);
		}

		/// <summary>
		/// Aggregates compiler diagnostics for assemblies compiled by the pending request.
		/// </summary>
		/// <param name="assemblyPath">Compiled assembly path.</param>
		/// <param name="messages">Compiler diagnostics emitted for the assembly.</param>
		private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
		{
			if (IsAssetImportWorker) return;
			if (messages == null) return;
			if (!SessionState.GetBool(PendingKey, false)) BeginObservedCompilation(false);
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
			WriteCurrentResult(false);
		}

		/// <summary>
		/// Records compiler completion; successful requests still await reload readiness.
		/// </summary>
		/// <param name="context">Unity compile context object.</param>
		private static void OnCompilationFinished(object context)
		{
			if (IsAssetImportWorker) return;
			if (!SessionState.GetBool(PendingKey, false)) BeginObservedCompilation(false);
			SessionState.SetBool(CompilationFinishedKey, true);
			SessionState.SetString(CompileFinishedDomainKey, DomainId);
			// scriptCompilationFailed can still describe the previous pass in this domain.
			// Current diagnostics fail immediately; the global flag is checked after reload.
			if (SessionState.GetInt(ErrorCountKey, 0) > 0)
			{
				SetCompletedStatus("failed", "Script compilation finished with compiler errors.", GetSyncMethod(), false);
				return;
			}
			SessionState.SetBool(ReloadPendingKey, true);
			SessionState.SetString(StatusKey, "waiting_for_reload");
			SessionState.SetString(MessageKey, "Compiler callbacks finished; waiting for a fresh main-thread response after domain reload.");
			SessionState.SetString(ReloadTimeoutAtKey, (EditorApplication.timeSinceStartup + ReloadTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			WriteCurrentResult(false);
		}

		/// <summary>
		/// Completes a compile request when Unity accepts the request but no compile pass starts.
		/// </summary>
		private static void PollCompileStartTimeout()
		{
			if (IsAssetImportWorker) return;
			ObserveMainThread();
			if (!SessionState.GetBool(PendingKey, false))
			{
				EditorApplication.update -= PollCompileStartTimeout;
				return;
			}
			if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
			if (SessionState.GetBool(CompilationStartedKey, false))
			{
				if (SessionState.GetInt(ErrorCountKey, 0) > 0)
					SetCompletedStatus("failed", "Script compilation finished with compiler errors.", GetSyncMethod(), false);
				else if (ReadEditorTime(ReloadTimeoutAtKey) > 0.0d && EditorApplication.timeSinceStartup >= ReadEditorTime(ReloadTimeoutAtKey))
					SetCompletedStatus("inconclusive", "Compilation completion and post-reload main-thread readiness were not both observed.", GetSyncMethod(), false);
				return;
			}
			double timeoutAt = ReadEditorTime(CompileTimeoutAtKey);
			if (timeoutAt > 0.0d && EditorApplication.timeSinceStartup >= timeoutAt)
				SetCompletedStatus("inconclusive", "Unity did not start an observable script compilation pass.", GetSyncMethod(), false);
		}

		/// <summary>
		/// Keeps status truthful when callers poll while Unity is compiling.
		/// </summary>
		private static void UpdateTransientCompileStatus()
		{
			if (!SessionState.GetBool(PendingKey, false))
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
			SessionState.SetString(StatusKey, status);
			SessionState.SetString(MessageKey, message);
			SessionState.SetString(SyncMethodKey, syncMethod);
			SessionState.SetString(FinishedUtcKey, string.Empty);
			EditorApplication.update -= PollCompileStartTimeout;
			EditorApplication.update += PollCompileStartTimeout;
			WriteCurrentResult(false);
		}

		/// <summary>
		/// Clears state that must not leak from an earlier validation request.
		/// </summary>
		private static void ResetRequestState()
		{
			SessionState.SetBool(PendingKey, false);
			SessionState.SetBool(CompilationStartedKey, false);
			SessionState.SetString(StatusKey, "idle");
			SessionState.SetString(MessageKey, string.Empty);
			SessionState.SetString(SyncMethodKey, string.Empty);
			SessionState.SetString(RequestedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			SessionState.SetString(FinishedUtcKey, string.Empty);
			SessionState.SetString(CompileTimeoutAtKey, string.Empty);
			SessionState.SetInt(ErrorCountKey, 0);
			SessionState.SetInt(WarningCountKey, 0);
			SessionState.SetString(RequestIdKey, Guid.NewGuid().ToString("N"));
			SessionState.SetInt(RequestOwnerPidKey, EditorPid);
			SessionState.SetString(OperationKey, string.Empty);
			SessionState.SetBool(CompilationFinishedKey, false);
			SessionState.SetBool(CompileSucceededKey, false);
			SessionState.SetBool(SyncSucceededKey, false);
			SessionState.SetBool(DiagnosticsCompleteKey, false);
			SessionState.SetBool(ReloadPendingKey, false);
			SessionState.SetString(CompileFinishedDomainKey, string.Empty);
			SessionState.SetString(ReloadTimeoutAtKey, string.Empty);
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
			SessionState.SetBool(ReloadPendingKey, false);
			if (!success) SessionState.SetBool(CompileSucceededKey, false);
			SessionState.SetString(StatusKey, status);
			SessionState.SetString(MessageKey, message);
			SessionState.SetString(SyncMethodKey, syncMethod);
			if (string.IsNullOrEmpty(SessionState.GetString(RequestedUtcKey, string.Empty)))
			{
				SessionState.SetString(RequestedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			}

			SessionState.SetString(FinishedUtcKey, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
			SessionState.SetString(CompileTimeoutAtKey, string.Empty);
			WriteCurrentResult(success);
		}

		private static int ReadEditorPid()
		{
			using (var process = System.Diagnostics.Process.GetCurrentProcess()) return process.Id;
		}

		private static void BeginObservedCompilation(bool completeDiagnostics)
		{
			ResetRequestState();
			SessionState.SetString(OperationKey, "observed_compile");
			SessionState.SetBool(CompilationStartedKey, true);
			SessionState.SetBool(DiagnosticsCompleteKey, completeDiagnostics);
			SessionState.SetString(ReloadTimeoutAtKey, (EditorApplication.timeSinceStartup + ReloadTimeoutSeconds).ToString(CultureInfo.InvariantCulture));
			SetRunningStatus("compiling", "Observing an existing Unity compilation; no compile was replayed.", "existing_compile");
		}

		private static void OnBeforeAssemblyReload()
		{
			if (IsAssetImportWorker || !OwnsRequest || !SessionState.GetBool(PendingKey, false)) return;
			SessionState.SetBool(ReloadPendingKey, true);
			WriteCurrentResult(false);
		}

		/// <summary>Called only on Unity's main thread; a response in the compiler domain is not reload proof.</summary>
		internal static void ObserveMainThread()
		{
			if (IsAssetImportWorker) return;
			MainThreadObservedUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
			if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
			if (!SessionState.GetBool(PendingKey, false))
			{
				if (SessionState.GetBool(ReloadPendingKey, false))
				{
					SessionState.SetBool(ReloadPendingKey, false);
					WriteCurrentResult(true);
				}
				return;
			}
			if (!OwnsRequest)
			{
				SetCompletedStatus("inconclusive", "Validation request ownership does not match this Editor process. Request a new validation.", GetSyncMethod(), false);
				return;
			}
			string compilerDomain = SessionState.GetString(CompileFinishedDomainKey, string.Empty);
			if (!SessionState.GetBool(CompilationStartedKey, false) || !SessionState.GetBool(CompilationFinishedKey, false) ||
				string.IsNullOrEmpty(compilerDomain) || compilerDomain == DomainId) return;
			if (SessionState.GetInt(ErrorCountKey, 0) > 0 || EditorUtility.scriptCompilationFailed)
			{
				SetCompletedStatus("failed", "Compiler errors remain after domain reload.", GetSyncMethod(), false);
				return;
			}
			if (!SessionState.GetBool(DiagnosticsCompleteKey, false))
			{
				SetCompletedStatus("inconclusive", "The reloaded main thread responded, but compilation diagnostics were not observed from the start.", GetSyncMethod(), false);
				return;
			}
			SessionState.SetBool(CompileSucceededKey, true);
			SetCompletedStatus("succeeded", "Script compilation completed and the reloaded main thread responded.", GetSyncMethod(), true);
		}

		/// <summary>
		/// Synchronizes project files using the current code editor integration when available.
		/// </summary>
		/// <returns>Name of the synchronization path that ran.</returns>
		private static string SynchronizeProjectFiles()
		{
			string codeEditorSync = SynchronizeWithCurrentCodeEditor();
			if (!string.IsNullOrEmpty(codeEditorSync))
			{
				return codeEditorSync;
			}

			string syncVs = InvokeStaticUnityMethod("UnityEditor.SyncVS", "SyncSolution");
			if (!string.IsNullOrEmpty(syncVs))
			{
				return syncVs;
			}

			return string.Empty;
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
			SystemAssembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
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
			if (IsAssetImportWorker || !OwnsRequest) return;
			string resultPath = GetResultPath();
			Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
			string temporaryPath = resultPath + ".tmp";
			File.WriteAllText(temporaryPath, BuildStatusJson(success));
			if (File.Exists(resultPath)) File.Replace(temporaryPath, resultPath, null);
			else File.Move(temporaryPath, resultPath);
		}

		/// <summary>
		/// Builds a JSON status object for MCP clients and file polling.
		/// </summary>
		/// <param name="success">Whether the current status should be treated as successful by MCP clients.</param>
		/// <returns>Escaped JSON status object.</returns>
		private static string BuildStatusJson(bool success)
		{
			bool pending = SessionState.GetBool(PendingKey, false);
			bool compileSucceeded = SessionState.GetBool(CompileSucceededKey, false);
			bool syncSucceeded = SessionState.GetBool(SyncSucceededKey, false);
			success = success && OwnsRequest && !pending && GetStatus() == "succeeded" && (compileSucceeded || syncSucceeded);
			return "{\"success\":" + ToJsonBool(success) +
				",\"tool\":\"editor_validation\"" +
				",\"requestId\":\"" + EditorControlHelpers.Escape(SessionState.GetString(RequestIdKey, string.Empty)) + "\"" +
				",\"operation\":\"" + EditorControlHelpers.Escape(SessionState.GetString(OperationKey, string.Empty)) + "\"" +
				",\"projectPath\":\"" + EditorControlHelpers.Escape(ProjectPath) + "\"" +
				",\"editorPid\":" + EditorPid.ToString(CultureInfo.InvariantCulture) +
				",\"domainId\":\"" + DomainId + "\"" +
				",\"capturedUtc\":\"" + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture) + "\"" +
				",\"mainThreadObservedUtc\":\"" + MainThreadObservedUtc + "\"" +
				",\"compileSucceeded\":" + ToJsonBool(compileSucceeded) +
				",\"syncSucceeded\":" + ToJsonBool(syncSucceeded) +
				",\"compilationStarted\":" + ToJsonBool(SessionState.GetBool(CompilationStartedKey, false)) +
				",\"compilationFinished\":" + ToJsonBool(SessionState.GetBool(CompilationFinishedKey, false)) +
				",\"diagnosticsComplete\":" + ToJsonBool(SessionState.GetBool(DiagnosticsCompleteKey, false)) +
				",\"reloadPending\":" + ToJsonBool(SessionState.GetBool(ReloadPendingKey, false)) +
				",\"isUpdating\":" + ToJsonBool(EditorApplication.isUpdating) +
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
			if (!double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
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
