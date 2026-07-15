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
    /// calls are dispatched straight into the queue. In projects where MCP was
    /// explicitly enabled, the bridge is brought up at editor load (and re-adopted
    /// on every domain reload) so the catalog is published before an agent session
    /// initializes. Disabled projects remain dormant. <see cref="EnsureStarted"/>
    /// is idempotent, so an agent window calling it too is harmless.
    /// </summary>
    [InitializeOnLoad]
    internal static class UntermMcp
    {
        /// <summary>Native wrapper owned only while this project's MCP bridge is enabled.</summary>
        private static UntermNative _native;

        static UntermMcp()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            // Enabled projects publish before any agent session initializes.
            // Disabled projects perform no native load or catalog discovery.
            if (UntermMcpSecurity.Enabled)
                EditorApplication.delayCall += EnsureStarted;
#endif
        }

        /// Whether the tool bridge is up (catalog published and draining).
        public static bool Started => _native != null;

        /// Publish the Unity tool catalog and hook the per-tick drain (idempotent).
        public static void EnsureStarted()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            if (!UntermMcpSecurity.Enabled || _native != null) return;
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

        /// <summary>Start or stop the bridge after this project's MCP setting changes.</summary>
        public static void RefreshTools()
        {
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            if (UntermMcpSecurity.Enabled)
            {
                EnsureStarted();
                _native?.McpSetTools(UntermMcpServer.ToolsJson());
                return;
            }
            Stop();
#endif
        }

        // Run any queued tool calls on the main thread.
        private static void Poll()
        {
            if (UntermMcpSecurity.Enabled && _native != null) UntermMcpServer.Poll(_native);
        }

        /// <summary>Remove all active MCP work without loading native state for disabled projects.</summary>
        private static void Stop()
        {
            EditorApplication.update -= Poll;
            UntermMcpServer.Stop(_native);
            _native = null;
        }
    }
}
