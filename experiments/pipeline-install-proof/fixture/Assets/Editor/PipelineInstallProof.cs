using System;
using System.IO;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
public static class PipelineInstallProof
{
    private const string Prefix = "PipelineInstallProof.";
    private static double stableSince = -1;
    private static bool baselineReady;
    private static bool installedReady;
    private static bool lastBusy;

    static PipelineInstallProof()
    {
        AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
        AssemblyReloadEvents.afterAssemblyReload += AfterReload;
        EditorApplication.update += Update;
        EditorApplication.quitting += () => Emit("quitting");
        Emit("initialize");
    }

    private static void Emit(string name)
    {
        Debug.Log("[PipelineInstallProof] " + name + "|" + DateTime.UtcNow.ToString("o")
            + "|" + Application.unityVersion + "|" + SessionState.GetInt(Prefix + "reloads", 0));
    }

    private static void BeforeReload() { Emit("before-reload"); }
    private static void AfterReload()
    {
        SessionState.SetInt(Prefix + "reloads", SessionState.GetInt(Prefix + "reloads", 0) + 1);
        Emit("after-reload");
    }

    private static void Update()
    {
        bool busy = EditorApplication.isCompiling || EditorApplication.isUpdating;
        if (busy != lastBusy) { Emit(busy ? "busy" : "idle"); lastBusy = busy; }
        if (busy) { stableSince = -1; return; }
        if (File.Exists("resolve.request"))
        {
            File.Delete("resolve.request");
            Emit("resolve-request");
            UnityEditor.PackageManager.Client.Resolve();
            stableSince = -1;
            return;
        }
        if (File.Exists("quit.request")) { Emit("normal-exit"); EditorApplication.Exit(0); return; }
        if (EditorApplication.timeSinceStartup > 420) { Emit("deadline-exit"); EditorApplication.Exit(1); return; }
        if (stableSince < 0) { stableSince = EditorApplication.timeSinceStartup; }
        if (EditorApplication.timeSinceStartup - stableSince < 2) { return; }
        if (!baselineReady)
        {
            baselineReady = true;
            if (!SessionState.GetBool(Prefix + "baseline", false))
            {
                SessionState.SetBool(Prefix + "baseline", true);
                SessionState.SetInt(Prefix + "baselineReloads", SessionState.GetInt(Prefix + "reloads", 0));
            }
            Emit("ready-baseline");
        }
        if (!installedReady && File.Exists("Packages/packages-lock.json")
            && File.ReadAllText("Packages/packages-lock.json").Contains("\"com.unity.pipeline\"")
            && SessionState.GetInt(Prefix + "reloads", 0) > SessionState.GetInt(Prefix + "baselineReloads", 0))
        {
            installedReady = true;
            Emit("ready-installed");
        }
    }
}
