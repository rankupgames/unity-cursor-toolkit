// Author: Miguel A. Lopez
// Project: Unity Cursor Toolkit
// Description: Native regression smoke for pending, inconclusive and post-compile status.
#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

public static class EditorValidationStatusSmoke
{
    private const BindingFlags StaticPrivate = BindingFlags.Static | BindingFlags.NonPublic;
    private static readonly string[] StringKeys = { "StatusKey", "MessageKey", "SyncMethodKey", "RequestedUtcKey", "FinishedUtcKey", "CompileTimeoutAtKey", "RequestIdKey", "OperationKey", "CompileFinishedDomainKey", "ReloadTimeoutAtKey" };
    private static readonly string[] BoolKeys = { "PendingKey", "CompilationStartedKey", "CompilationFinishedKey", "CompileSucceededKey", "SyncSucceededKey", "DiagnosticsCompleteKey", "ReloadPendingKey" };
    private static readonly string[] IntKeys = { "ErrorCountKey", "WarningCountKey", "RequestOwnerPidKey" };

    [Serializable]
    private sealed class Status
    {
        public bool success = false, pending = false, compileSucceeded = false, syncSucceeded = false, reloadPending = false;
        public string status = string.Empty, requestId = string.Empty, projectPath = string.Empty, domainId = string.Empty, capturedUtc = string.Empty, mainThreadObservedUtc = string.Empty, resultPath = string.Empty;
        public int editorPid = 0, errorCount = 0;
    }

    [MenuItem("Tools/Unity Cursor Toolkit/Validation/Smoke Status Signals")]
    public static void Run()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating || EditorUtility.scriptCompilationFailed)
            throw new InvalidOperationException("status_smoke_not_ready: use an idle Editor with no compile failure.");
        Type state = AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType("UnityCursorToolkit.MCP.EditorValidationState")).Single(type => type != null);
        Func<string, string> key = name => (string)state.GetField(name, StaticPrivate).GetValue(null);
        if (SessionState.GetBool(key("PendingKey"), false))
            throw new InvalidOperationException("status_smoke_busy: preserve the active validation request.");
        var strings = StringKeys.ToDictionary(name => key(name), name => SessionState.GetString(key(name), string.Empty));
        var booleans = BoolKeys.ToDictionary(name => key(name), name => SessionState.GetBool(key(name), false));
        var integers = IntKeys.ToDictionary(name => key(name), name => SessionState.GetInt(key(name), 0));
        string resultPath = (string)Invoke(state, "GetResultPath");
        byte[] originalResult = File.Exists(resultPath) ? File.ReadAllBytes(resultPath) : null;
        try
        {
            Invoke(state, "ResetRequestState");
            Invoke(state, "SetRunningStatus", "running", "Synthetic status-contract request.", "not_requested");
            Status pending = Read(state);
            Require(pending.pending && !pending.success && !pending.compileSucceeded, "A pending request must never report success.");
            Require(!string.IsNullOrEmpty(pending.requestId) && !string.IsNullOrEmpty(pending.domainId) && pending.editorPid > 0 &&
                !string.IsNullOrEmpty(pending.projectPath) && !string.IsNullOrEmpty(pending.capturedUtc) && !string.IsNullOrEmpty(pending.mainThreadObservedUtc), "Status must identify its request, project, process, domain and main-thread observation.");
            SessionState.SetString(key("CompileTimeoutAtKey"), "0.000001");
            Invoke(state, "PollCompileStartTimeout");
            Status noCompile = Read(state);
            Require(noCompile.status == "inconclusive" && !noCompile.pending && !noCompile.success && !noCompile.compileSucceeded, "A no-start deadline must not become compile success.");

            Invoke(state, "ResetRequestState");
            Invoke(state, "SetCompletedStatus", "succeeded", "No evidence supplied.", "not_requested", true);
            Require(!Read(state).success, "A success label without sync or compile evidence is insufficient.");
            SessionState.SetBool(key("SyncSucceededKey"), true);
            Status syncOnly = Read(state);
            Require(syncOnly.success && syncOnly.syncSucceeded && !syncOnly.compileSucceeded, "Sync-only success must not certify compilation.");
            Invoke(state, "WriteCurrentResult", true);
            string ownedResult = File.ReadAllText(syncOnly.resultPath);
            Invoke(state, "OnBeforeAssemblyReload");
            Require(!SessionState.GetBool(key("ReloadPendingKey"), false) && File.ReadAllText(syncOnly.resultPath) == ownedResult,
                "An idle reload must not create or replace validation evidence.");
            SessionState.SetString(key("RequestIdKey"), string.Empty);
            Invoke(state, "WriteCurrentResult", false);
            Require(File.ReadAllText(syncOnly.resultPath) == ownedResult, "Requestless state must not replace an owned validation result.");
            SessionState.SetString(key("RequestIdKey"), syncOnly.requestId);
            SessionState.SetInt(key("RequestOwnerPidKey"), 0);
            Invoke(state, "WriteCurrentResult", false);
            Require(File.ReadAllText(syncOnly.resultPath) == ownedResult, "A different process owner must not replace validation evidence.");
            SessionState.SetInt(key("RequestOwnerPidKey"), syncOnly.editorPid);

            Invoke(state, "ResetRequestState");
            Invoke(state, "SetRunningStatus", "running", "Synthetic compiler callback request.", "not_requested");
            Invoke(state, "OnCompilationStarted", new object());
            Invoke(state, "OnCompilationFinished", new object());
            Status compilerFinished = Read(state);
            Require(compilerFinished.status == "waiting_for_reload" && compilerFinished.pending && compilerFinished.reloadPending && !compilerFinished.success && !compilerFinished.compileSucceeded,
                "Compiler completion in the same domain must await post-reload main-thread readiness.");
            Invoke(state, "PollCompileStartTimeout");
            Require(!Read(state).compileSucceeded, "Polling the compiler domain must not fabricate a reload.");

            Invoke(state, "OnAssemblyCompilationFinished", "status-smoke", new[] { new CompilerMessage { type = CompilerMessageType.Error, message = "Synthetic status-contract compiler error." } });
            Invoke(state, "OnCompilationFinished", new object());
            Status failed = Read(state);
            Require(failed.status == "failed" && failed.errorCount == 1 && !failed.pending && !failed.success && !failed.compileSucceeded,
                "Compiler errors must dominate completion and reload status.");

            Invoke(state, "ResetRequestState");
            Invoke(state, "SetRunningStatus", "running", "Synthetic incomplete diagnostic request.", "not_requested");
            Invoke(state, "OnCompilationStarted", new object());
            Invoke(state, "OnCompilationFinished", new object());
            SessionState.SetString(key("CompileFinishedDomainKey"), compilerFinished.domainId + "-previous");
            SessionState.SetBool(key("DiagnosticsCompleteKey"), false);
            Status incomplete = Read(state);
            Require(incomplete.status == "inconclusive" && !incomplete.pending && !incomplete.success && !incomplete.compileSucceeded,
                "A fresh domain without complete compiler diagnostics must remain inconclusive.");

            Invoke(state, "ResetRequestState");
            Invoke(state, "SetRunningStatus", "running", "Synthetic complete diagnostic request.", "not_requested");
            Invoke(state, "OnCompilationStarted", new object());
            Invoke(state, "OnCompilationFinished", new object());
            SessionState.SetString(key("CompileFinishedDomainKey"), compilerFinished.domainId + "-previous");
            Status ready = Read(state);
            Require(ready.status == "succeeded" && !ready.pending && ready.success && ready.compileSucceeded,
                "Complete diagnostics and a fresh main-thread domain must complete the owned request.");
        }
        finally
        {
            foreach (var item in strings) SessionState.SetString(item.Key, item.Value);
            foreach (var item in booleans) SessionState.SetBool(item.Key, item.Value);
            foreach (var item in integers) SessionState.SetInt(item.Key, item.Value);
            if (originalResult == null) File.Delete(resultPath);
            else File.WriteAllBytes(resultPath, originalResult);
        }
        Debug.Log("EditorValidationStatusSmoke passed: pending/no-start/sync-only/ownership/compiler-finish/error/diagnostic contracts. Real compilation and domain-reload success still require a native compile run.");
    }

    private static Status Read(Type state) => JsonUtility.FromJson<Status>((string)Invoke(state, "GetStatusJson"));
    private static object Invoke(Type state, string name, params object[] arguments) => state.GetMethod(name, StaticPrivate).Invoke(null, arguments);
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("status_smoke_failed: " + message);
    }
}
#endif
