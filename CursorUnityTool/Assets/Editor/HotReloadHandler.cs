/*
 * HotReloadHandler.cs
 * 
 * This script provides hot reload functionality between a Unity project and VS Code/Cursor.
 * It creates a TCP server that listens for messages from the VS Code extension,
 * then triggers Unity's asset database to refresh when code changes are detected.
 * 
 * The handler automatically starts when Unity loads and supports multiple port fallbacks
 * if the default port is in use. Debug logs can be toggled through the Tools menu.
 *
 * Copyright (c) 2025 Rank Up Games LLC
 */

using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Text;
using System.Collections.Generic;

using UnityEngine;

#if UNITY_EDITOR
using UnityEditor;

#if UNITY_2019_1_OR_NEWER
using UnityEditor.Compilation;
#endif

/// <summary>
/// Editor window that handles hot reload functionality between Unity and VS Code/Cursor.
/// Implements a TCP server to listen for file change notifications.
/// </summary>
[InitializeOnLoad]
public class HotReloadHandler : EditorWindow
{
    // TCP server and communication components
    private static TcpListener server;
    private static Thread listenerThread;
    private static bool shouldRequestRefresh = false;
    private static int port = 55500; // Default port, will try alternatives if unavailable
    private static readonly Queue<string> messageQueue = new Queue<string>();
    private static bool isInitialized = false;
    private static bool isServerRunning = false;
    
    // Debug control flag - determines whether connection logs are shown
    private static bool showDebugLogs = false;
    private const string debugPrefKey = "UnityHotReloadHandler_ShowDebugLogs";
    
    // Used to check if we're already running
    private static Mutex instanceMutex;

    /// <summary>
    /// Static constructor called when Unity editor loads.
    /// Initializes the server and registers for editor events.
    /// </summary>
    static HotReloadHandler()
    {
        // Load debug setting from EditorPrefs
        showDebugLogs = EditorPrefs.GetBool(debugPrefKey, false);
        
        // Register for domain reload completion to restart the server
        EditorApplication.update += OnEditorUpdate;
        
        // Register shutdown handler
        AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
        EditorApplication.quitting += OnEditorQuitting;
        
        Initialize();
    }

    /// <summary>
    /// Initializes the hot reload server if not already running.
    /// Creates a mutex to ensure only one instance is active.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Start Server")]
    public static void Initialize()
    {
        if (isInitialized)
            return;

        // Acquire a named mutex to prevent multiple instances
        instanceMutex = new Mutex(true, "UnityHotReloadHandler", out bool createdNew);
        
        if (!createdNew)
        {
            Debug.Log("Another instance of Hot Reload server is already running. Skipping initialization.");
            instanceMutex.Close();
            instanceMutex = null;
            return;
        }

        Debug.Log("Starting Unity Hot Reload server...");
        
        // Start TCP listener thread
        StartListenerThread();
        
        isInitialized = true;
    }

    /// <summary>
    /// Stops the hot reload server and releases resources.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Stop Server")]
    public static void Shutdown()
    {
        if (!isInitialized)
            return;

        Debug.Log("Stopping Unity Hot Reload server...");
        
        // Unregister from update events
        EditorApplication.update -= OnEditorUpdate;
        
        StopServer();
        
        // Release the mutex
        if (instanceMutex != null)
        {
            instanceMutex.ReleaseMutex();
            instanceMutex.Close();
            instanceMutex = null;
        }
        
        isInitialized = false;
    }

    /// <summary>
    /// Toggles whether debug logs are shown in the console.
    /// Setting is persisted between editor sessions.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Toggle Debug Logs")]
    public static void ToggleDebugLogs()
    {
        showDebugLogs = !showDebugLogs;
        EditorPrefs.SetBool(debugPrefKey, showDebugLogs);
        Debug.Log($"Hot Reload: Debug logs are now {(showDebugLogs ? "enabled" : "disabled")}");
    }
    
    /// <summary>
    /// Validates the Toggle Debug Logs menu item and sets its checked state.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Toggle Debug Logs", true)]
    public static bool ValidateToggleDebugLogs()
    {
        Menu.SetChecked("Tools/Hot Reload/Toggle Debug Logs", showDebugLogs);
        return true;
    }

    /// <summary>
    /// Starts the listener thread for TCP communication.
    /// Ensures any existing thread is stopped first.
    /// </summary>
    private static void StartListenerThread()
    {
        // Stop any existing thread first
        if (listenerThread != null && listenerThread.IsAlive)
        {
            StopServer();
        }
        
        // Start new thread
        listenerThread = new Thread(ListenerThreadFunction);
        listenerThread.IsBackground = true;
        listenerThread.Start();
    }
    
    /// <summary>
    /// Stops the TCP server and cleans up the listener thread.
    /// </summary>
    private static void StopServer()
    {
        isServerRunning = false;
        
        // Stop TCP listener
        if (server != null)
        {
            try
            {
                server.Stop();
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Error stopping server: {ex.Message}");
            }
            server = null;
        }
        
        // Stop thread
        if (listenerThread != null && listenerThread.IsAlive)
        {
            try 
            {
                listenerThread.Join(500); // Wait for thread to exit gracefully
                
                if (listenerThread.IsAlive)
                {
                    listenerThread.Abort(); // Force abort if thread doesn't exit gracefully
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Error stopping thread: {ex.Message}");
            }
            
            listenerThread = null;
        }
    }

    /// <summary>
    /// Called before Unity reloads assemblies.
    /// Stops the server to prevent threading issues during domain reload.
    /// </summary>
    private static void OnBeforeAssemblyReload()
    {
        StopServer();
    }
    
    /// <summary>
    /// Called when Unity editor is quitting.
    /// Performs cleanup of resources.
    /// </summary>
    private static void OnEditorQuitting()
    {
        Shutdown();
    }

    /// <summary>
    /// Called every editor update frame.
    /// Processes any queued messages from the TCP listener and triggers refreshes.
    /// </summary>
    private static void OnEditorUpdate()
    {
        // Process any queued messages
        lock (messageQueue)
        {
            while (messageQueue.Count > 0)
            {
                string message = messageQueue.Dequeue();
                ProcessMessage(message);
            }
        }

        // Check if we should refresh
        if (shouldRequestRefresh)
        {
            shouldRequestRefresh = false;
            RefreshAssets();
        }
    }

    /// <summary>
    /// Thread function that listens for TCP connections.
    /// Tries multiple ports if the default port is unavailable.
    /// </summary>
    private static void ListenerThreadFunction()
    {
        // Try multiple ports if necessary
        int[] portsToTry = new int[] { port, 55501, 55502, 55503, 55504 };
        bool serverStarted = false;
        
        // Try each port until we find one that works
        foreach (int currentPort in portsToTry)
        {
            try
            {
                server = new TcpListener(IPAddress.Parse("127.0.0.1"), currentPort);
                server.Start();
                
                port = currentPort; // Store the port we successfully bound to
                serverStarted = true;
                
                Debug.Log($"Unity Hot Reload server listening on port {port}");
                break;
            }
            catch (SocketException ex)
            {
                // 10048 is the "address already in use" error on Windows
                // 48 is the equivalent on Unix/macOS
                if (ex.ErrorCode == 10048 || ex.ErrorCode == 48)
                {
                    Debug.LogWarning($"Port {currentPort} is already in use, trying next port...");
                    continue;
                }
                else
                {
                    Debug.LogError($"Socket error: {ex.Message} (ErrorCode: {ex.ErrorCode})");
                    return;
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"Error starting server: {ex.Message}");
                return;
            }
        }
        
        if (!serverStarted)
        {
            Debug.LogError("Failed to start Hot Reload server. All ports are in use.");
            return;
        }

        isServerRunning = true;
        
        // Main server loop
        try
        {
            // Buffer for reading data
            byte[] bytes = new byte[1024];
            
            while (isServerRunning)
            {
                try
                {
                    // Wait for a client connection
                    using (TcpClient client = server.AcceptTcpClient())
                    {
                        // Only log connection if debug logs are enabled
                        if (showDebugLogs)
                        {
                            Debug.Log("VS Code connected to Unity Hot Reload server");
                        }
                        
                        // Handle client communication
                        using (NetworkStream stream = client.GetStream())
                        {
                            int length;
                            // Read incoming stream
                            while ((length = stream.Read(bytes, 0, bytes.Length)) != 0)
                            {
                                var incomingData = new byte[length];
                                Array.Copy(bytes, 0, incomingData, 0, length);
                                string clientMessage = Encoding.ASCII.GetString(incomingData);
                                
                                // Queue message for processing on main thread
                                lock (messageQueue)
                                {
                                    messageQueue.Enqueue(clientMessage);
                                }
                            }
                        }
                    }
                }
                catch (SocketException ex)
                {
                    if (!isServerRunning)
                    {
                        // Server is shutting down, this is expected
                        break;
                    }
                    
                    Debug.LogError($"Socket error while accepting client: {ex.Message}");
                }
            }
        }
        catch (ThreadAbortException)
        {
            if (showDebugLogs)
            {
                Debug.Log("Unity Hot Reload server thread aborted");
            }
        }
        catch (Exception e)
        {
            if (!isServerRunning)
            {
                // Server is shutting down, this is expected
                if (showDebugLogs)
                {
                    Debug.Log("Unity Hot Reload server stopped");
                }
            }
            else
            {
                Debug.LogError($"Unity Hot Reload server error: {e.Message}");
            }
        }
        finally
        {
            // Ensure server is stopped
            if (server != null)
            {
                try 
                {
                    server.Stop();
                    server = null;
                }
                catch (Exception) 
                {
                    // Ignore errors during cleanup
                }
            }
        }
    }

    /// <summary>
    /// Processes messages received from the TCP client.
    /// Currently, any message will trigger a refresh.
    /// </summary>
    /// <param name="message">The message received from the client</param>
    private static void ProcessMessage(string message)
    {
        if (showDebugLogs)
        {
            Debug.Log($"Received message: {message}");
        }
        
        // Simple protocol - any message triggers a refresh
        shouldRequestRefresh = true;
    }

    /// <summary>
    /// Refreshes Unity's asset database and triggers script compilation.
    /// Called when changes are detected from VS Code/Cursor.
    /// </summary>
    private static void RefreshAssets()
    {
        try
        {
            Debug.Log("Hot Reload: Refreshing Unity assets...");
            
            // Refresh the asset database
            AssetDatabase.Refresh(ImportAssetOptions.Default);
            
            // Request script compilation (Unity 2019.1 or newer)
            #if UNITY_2019_1_OR_NEWER
            CompilationPipeline.RequestScriptCompilation();
            #endif
            
            if (showDebugLogs)
            {
                Debug.Log("Hot Reload: Refresh complete");
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"Hot Reload refresh error: {e.Message}");
        }
    }
    
    /// <summary>
    /// Returns the current port being used by the hot reload server.
    /// Useful for other components that need to communicate with VS Code.
    /// </summary>
    /// <returns>The current port number</returns>
    public static int GetPort()
    {
        return port;
    }
}

#endif // UNITY_EDITOR 
