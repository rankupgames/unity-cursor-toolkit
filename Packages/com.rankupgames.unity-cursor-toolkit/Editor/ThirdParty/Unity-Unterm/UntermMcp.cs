using System;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// Owns the editor-global MCP server bridge. The native plugin holds the MCP
    /// server in process globals (so the tool catalog and queued calls survive C#
    /// domain reloads); this class publishes the Unity tool catalog to it and
    /// drains queued tool calls on the main thread each tick.
    ///
    /// There is no transport and no port: the agent (the native AgentView) is
    /// wired to this server in-process over the control protocol, so its tool
    /// calls are dispatched straight into the queue. The bridge is brought up
    /// eagerly at editor load (and re-adopted on every domain reload), so the
    /// catalog is published before any agent session initializes — never a window
    /// race where an agent connects to an empty tool list. <see cref="EnsureStarted"/>
    /// is idempotent, so the agent window calling it too is harmless.
    /// </summary>
    [InitializeOnLoad]
    internal static class UntermMcp
    {
        private static UntermNative _native;

        static UntermMcp()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            // Bring the bridge up at editor load — eagerly, not lazily when the
            // first agent window opens — so the tool catalog is always published
            // up front. Deferred one tick so AssetDatabase (GUID -> plugin path)
            // is ready; a domain reload re-runs this and re-adopts the native
            // server, whose queued calls survive the reload.
            EditorApplication.delayCall += EnsureStarted;
#endif
        }

        /// Whether the tool bridge is up (catalog published and draining).
        public static bool Started => _native != null;

        /// Publish the Unity tool catalog and hook the per-tick drain (idempotent).
        public static void EnsureStarted()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            if (_native != null) return;
            try
            {
                _native = new UntermNative();
                _native.Load(UntermWindow.PluginPath);
                _native.McpSetTools(UntermMcpServer.ToolsJson());
                UntermMcpServer.StartLogCapture();
                EditorApplication.update += Poll;
            }
            catch (Exception e)
            {
                _native = null;
                Debug.LogError("[Unterm] MCP tool bridge setup failed: " + e);
            }
#endif
        }

        /// <summary>Republish the catalog after the user enables or disables MCP.</summary>
        public static void RefreshTools()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            EnsureStarted();
            _native?.McpSetTools(UntermMcpServer.ToolsJson());
#endif
        }

        // Run any queued tool calls on the main thread.
        private static void Poll()
        {
            if (_native != null) UntermMcpServer.Poll(_native);
        }
    }
}
