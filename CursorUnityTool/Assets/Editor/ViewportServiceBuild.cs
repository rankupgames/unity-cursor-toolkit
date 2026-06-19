/*
 * ViewportServiceBuild.cs
 *
 * Licensed editor-only build automation for the runtime Viewport Service.
 */

using System;
using System.IO;
using System.Linq;

using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

using UnityCursorToolkit.ViewportService;

namespace UnityCursorToolkit
{

public static class ViewportServiceBuild
{
    private const string ScenePath = "Assets/Scenes/ViewportService.unity";

    public static void BuildFromCommandLine()
    {
        string outputPath = GetArg("-uctViewportBuildPath", DefaultBuildPath());
        BuildTarget target = ResolveBuildTarget(GetArg("-uctViewportBuildTarget", ""));
        Build(outputPath, target);
    }

    [MenuItem("Tools/Unity Cursor Toolkit/Build Viewport Service Player")]
    public static void BuildMenu()
    {
        Build(DefaultBuildPath(), EditorUserBuildSettings.activeBuildTarget);
    }

    public static void Build(string outputPath, BuildTarget target)
    {
        string scenePath = EnsureScene();
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? "Builds/ViewportService");

        BuildPlayerOptions options = new BuildPlayerOptions
        {
            scenes = new[] { scenePath },
            locationPathName = outputPath,
            target = target,
            options = BuildOptions.None
        };

        BuildSummary summary = BuildPipeline.BuildPlayer(options).summary;
        if (summary.result != BuildResult.Succeeded)
        {
            throw new InvalidOperationException($"Viewport Service build failed: {summary.result}");
        }

        Debug.Log($"Viewport Service player built: {outputPath}");
    }

    public static string EnsureScene()
    {
        Directory.CreateDirectory("Assets/Scenes");

        Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        GameObject server = new GameObject("Viewport Service Server");
        server.AddComponent<ViewportServiceServer>();

        GameObject cameraObject = new GameObject("Main Camera");
        cameraObject.tag = "MainCamera";
        Camera camera = cameraObject.AddComponent<Camera>();
        camera.clearFlags = CameraClearFlags.Skybox;
        camera.fieldOfView = 55f;
        cameraObject.transform.position = new Vector3(0f, 3f, -7f);
        cameraObject.transform.rotation = Quaternion.Euler(25f, 0f, 0f);

        GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        cube.name = "Viewport Service Target";
        cube.transform.position = Vector3.zero;

        GameObject lightObject = new GameObject("Directional Light");
        Light light = lightObject.AddComponent<Light>();
        light.type = LightType.Directional;
        light.intensity = 1.2f;
        lightObject.transform.rotation = Quaternion.Euler(50f, -35f, 0f);

        EditorSceneManager.SaveScene(scene, ScenePath);
        AssetDatabase.SaveAssets();

        EnsureSceneInBuildSettings(ScenePath);
        return ScenePath;
    }

    private static void EnsureSceneInBuildSettings(string scenePath)
    {
        EditorBuildSettingsScene[] current = EditorBuildSettings.scenes;
        if (current.Any(scene => scene.path == scenePath))
        {
            return;
        }

        EditorBuildSettings.scenes = current
            .Concat(new[] { new EditorBuildSettingsScene(scenePath, true) })
            .ToArray();
    }

    private static string DefaultBuildPath()
    {
        string root = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Builds", "ViewportService"));
        switch (EditorUserBuildSettings.activeBuildTarget)
        {
            case BuildTarget.StandaloneOSX:
                return Path.Combine(root, "ViewportService.app");
            case BuildTarget.StandaloneWindows:
            case BuildTarget.StandaloneWindows64:
                return Path.Combine(root, "ViewportService.exe");
            default:
                return Path.Combine(root, "ViewportService");
        }
    }

    private static BuildTarget ResolveBuildTarget(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return EditorUserBuildSettings.activeBuildTarget;
        }

        switch (value.Trim().ToLowerInvariant())
        {
            case "mac":
            case "macos":
            case "standaloneosx":
                return BuildTarget.StandaloneOSX;
            case "win":
            case "windows":
            case "standalonewindows64":
                return BuildTarget.StandaloneWindows64;
            case "linux":
            case "standalonelinux64":
                return BuildTarget.StandaloneLinux64;
            default:
                throw new ArgumentException($"Unsupported Viewport Service build target: {value}");
        }
    }

    private static string GetArg(string name, string fallback)
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == name)
            {
                return args[i + 1];
            }
        }
        return fallback;
    }
}

}
