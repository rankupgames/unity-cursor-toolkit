/*
 * HotReloadHandler.cs
 *
 * This script provides hot reload functionality between a Unity project and VS Code/Cursor.
 * It creates a TCP server that listens for messages from the VS Code extension,
 * then triggers Unity's asset database to refresh when code changes are detected.
 *
 * The handler supports three main commands:
 * - Start: Starts the server on the default or next available port
 * - Stop: Stops the server and disconnects all clients
 * - Reload: Restarts the server on the same port (maintains connection stability)
 *
 * Copyright (c) 2025 Rank Up Games LLC
 */

using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Text;
using System.Collections.Generic;
using System.Linq;

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
    private static int currentPort = 55500; // Current port being used
    private static int lastSuccessfulPort = 55500; // Last port that successfully connected
    private static readonly Queue<string> messageQueue = new Queue<string>();
    private static bool isInitialized = false;
    private static bool isServerRunning = false;
    private static readonly List<TcpClient> connectedClients = new List<TcpClient>();
    private static readonly object clientListLock = new object();

    // Port configuration
    private const int DEFAULT_PORT = 55500;
    private static readonly int[] ALTERNATIVE_PORTS = { 55500, 55501, 55502, 55503, 55504 };

    // Add retry configuration for port binding
    private const int PORT_RETRY_ATTEMPTS = 5;
    private const int PORT_RETRY_DELAY_MS = 200;

    // Debug control flag - determines whether connection logs are shown
    private static bool showDebugLogs = false;
    private const string debugPrefKey = "UnityHotReloadHandler_ShowDebugLogs";
    private const string lastPortPrefKey = "UnityHotReloadHandler_LastPort";

    // Used to check if we're already running
    private static Mutex instanceMutex;
    private static bool wasRunningBeforeReload = false;
    private const string wasRunningPrefKey = "UnityHotReloadHandler_WasRunning";

    private static readonly Queue<Action> mainThreadActions = new Queue<Action>();
    private static readonly object mainThreadActionsLock = new object();

    /// <summary>
    /// Static constructor called when Unity editor loads.
    /// Initializes the server and registers for editor events.
    /// </summary>
    static HotReloadHandler()
    {
        // Load debug setting from EditorPrefs
        showDebugLogs = EditorPrefs.GetBool(debugPrefKey, false);
        lastSuccessfulPort = EditorPrefs.GetInt(lastPortPrefKey, DEFAULT_PORT);
        currentPort = lastSuccessfulPort;

        // Check if we were running before domain reload
        wasRunningBeforeReload = EditorPrefs.GetBool(wasRunningPrefKey, false);

        // Register for domain reload completion to restart the server
        EditorApplication.update += OnEditorUpdate;

        // Register shutdown handler
        AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
        EditorApplication.quitting += OnEditorQuitting;

        // Auto-start on Unity load
        EditorApplication.delayCall += () => {
            if (!isInitialized && wasRunningBeforeReload)
            {
                // Clear the flag
                EditorPrefs.SetBool(wasRunningPrefKey, false);
                StartWithoutMutex();
            }
        };
    }

    /// <summary>
    /// Starts the hot reload server if not already running.
    /// Creates a mutex to ensure only one instance is active.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Start")]
    public static void Start()
    {
        if (isInitialized && isServerRunning)
        {
            Debug.Log("Hot Reload server is already running.");
            return;
        }

        // Try to create or open existing mutex
        bool createdNew = false;
        try
        {
            instanceMutex = new Mutex(true, "UnityHotReloadHandler", out createdNew);

            if (!createdNew)
            {
                // Try to get ownership of existing mutex with a timeout
                try
                {
                    if (instanceMutex.WaitOne(100))
                    {
                        // We got ownership, likely from a crashed instance
                        createdNew = true;
                    }
                }
                catch
                {
                    // Mutex is abandoned or we can't get it
                    createdNew = false;
                }
            }
        }
        catch (AbandonedMutexException)
        {
            // The mutex was abandoned, we can take ownership
            createdNew = true;
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"Mutex error: {ex.Message}. Starting without mutex protection.");
            instanceMutex = null;
            createdNew = true; // Proceed anyway
        }

        if (!createdNew && instanceMutex != null)
        {
            // Check if a server is actually running on our port
            if (!IsPortInUse(currentPort))
            {
                Debug.Log("Previous instance mutex found but port is free. Proceeding with startup.");
                try
                {
                    instanceMutex.ReleaseMutex();
                    instanceMutex.Close();
                }
                catch { }
                instanceMutex = null;
                createdNew = true;
            }
            else
            {
                Debug.Log("Another instance of Hot Reload server is already running. Skipping initialization.");
                instanceMutex.Close();
                instanceMutex = null;
                return;
            }
        }

        Debug.Log("Starting Unity Hot Reload server...");

        // Start TCP listener thread
        StartListenerThread();

        isInitialized = true;

        // Mark that we're running for domain reload recovery
        EditorPrefs.SetBool(wasRunningPrefKey, true);
    }

    /// <summary>
    /// Starts the server without mutex check, used after domain reload.
    /// </summary>
    private static void StartWithoutMutex()
    {
        if (isInitialized && isServerRunning)
        {
            return;
        }

        Debug.Log("Restarting Unity Hot Reload server after domain reload...");

        // Start TCP listener thread
        StartListenerThread();

        isInitialized = true;
    }

    /// <summary>
    /// Checks if a specific port is in use.
    /// </summary>
    private static bool IsPortInUse(int port)
    {
        System.Net.Sockets.TcpListener tempListener = null;
        try
        {
            // Explicitly qualify TcpListener and IPAddress to ensure correct type resolution
            tempListener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Any, port);
            tempListener.Start();
            return false; // Port is available if we could start
        }
        catch (System.Net.Sockets.SocketException ex)
        {
            // Check if the specific error is "Address already in use"
            // Common error codes for this are 10048 (WSAEADDRINUSE on Windows) or 48/98 on Unix-like systems.
            if (ex.SocketErrorCode == System.Net.Sockets.SocketError.AddressAlreadyInUse || ex.ErrorCode == 48 || ex.ErrorCode == 98 || ex.ErrorCode == 10048)
            {
                return true; // Port is in use
            }
            // For other socket exceptions, we might not be sure, but typically means not usable.
            // Depending on desired behavior, could return true or re-throw. For IsPortInUse, true is safer.
            return true;
        }
        catch
        {
            // Any other exception (e.g., security, permissions) likely means port is not usable by us.
            return true;
        }
        finally
        {
            if (tempListener != null)
            {
                tempListener.Stop(); // Stop also closes the listener socket
            }
        }
    }

    /// <summary>
    /// Stops the hot reload server and releases resources.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Stop")]
    public static void Stop()
    {
        if (!isInitialized)
        {
            Debug.Log("Hot Reload server is not running.");
            return;
        }

        Debug.Log("Stopping Unity Hot Reload server...");

        StopServer();

        // Release the mutex
        if (instanceMutex != null)
        {
            try
            {
                instanceMutex.ReleaseMutex();
                instanceMutex.Close();
            }
            catch { }
            instanceMutex = null;
        }

        isInitialized = false;

        // Clear the running flag
        EditorPrefs.SetBool(wasRunningPrefKey, false);
    }

    /// <summary>
    /// Reloads the hot reload server on the same port.
    /// This maintains connection stability with the VS Code extension.
    /// </summary>
    [MenuItem("Tools/Hot Reload/Reload")]
    public static void Reload()
    {
        if (!isInitialized)
        {
            Debug.Log("Hot Reload server is not running. Starting fresh...");
            Start();
            return;
        }

        Debug.Log($"Reloading Unity Hot Reload server on port {currentPort}...");

        // Store the current port to reuse it
        int portToReuse = currentPort;

        // Stop the server without releasing the mutex
        StopServer();

        // Try to restart on the same port with retries
        bool restarted = false;
        for (int attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt++)
        {
            // Increasing delay between attempts to allow OS to release the port
            Thread.Sleep(PORT_RETRY_DELAY_MS * (attempt + 1));

            // Force the port for this reload
            currentPort = portToReuse;

            if (TryStartOnSpecificPort(portToReuse))
            {
                restarted = true;
                Debug.Log($"Hot Reload server successfully reloaded on port {currentPort}");
                break;
            }

            if (showDebugLogs)
            {
                Debug.Log($"Port {portToReuse} not available yet, attempt {attempt + 1}/{PORT_RETRY_ATTEMPTS}");
            }
        }

        // If we couldn't restart on the same port, start normally
        if (!restarted)
        {
            Debug.LogWarning($"Could not reload on port {portToReuse}, starting on available port...");
            StartListenerThread();
        }
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
    /// Enhanced with better socket cleanup for port reuse.
    /// </summary>
    private static void StopServer()
    {
        isServerRunning = false;

        // Disconnect all clients
        lock (clientListLock)
        {
            foreach (var client in connectedClients)
            {
                try
                {
                    if (client.Connected)
                    {
                        // Shutdown the connection before closing
                        client.Client.Shutdown(SocketShutdown.Both);
                        client.Close();
                    }
                }
                catch (Exception ex)
                {
                    if (showDebugLogs)
                    {
                        Debug.LogWarning($"Error closing client connection: {ex.Message}");
                    }
                }
            }
            connectedClients.Clear();
        }

        // Stop TCP listener with proper cleanup
        if (server != null)
        {
            try
            {
                server.Stop();

                // Explicitly close and dispose the underlying socket
                if (server.Server != null)
                {
                    server.Server.Close();
                    server.Server.Dispose();
                }
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
                listenerThread.Join(1000); // Give it more time to exit gracefully

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
        // Mark that we were running before reload
        if (isInitialized && isServerRunning)
        {
            EditorPrefs.SetBool(wasRunningPrefKey, true);
        }

        // Release mutex before domain reload
        if (instanceMutex != null)
        {
            try
            {
                instanceMutex.ReleaseMutex();
                instanceMutex.Close();
            }
            catch { }
            instanceMutex = null;
        }

        StopServer();
    }

    /// <summary>
    /// Called when Unity editor is quitting.
    /// Performs cleanup of resources.
    /// </summary>
    private static void OnEditorQuitting()
    {
        // Clear the running flag
        EditorPrefs.SetBool(wasRunningPrefKey, false);
        Stop();
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

        // Process actions queued for the main thread
        lock (mainThreadActionsLock)
        {
            while (mainThreadActions.Count > 0)
            {
                Action action = mainThreadActions.Dequeue();
                action?.Invoke();
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
    /// Prioritizes the last successful port or current port for stability.
    /// </summary>
    private static void ListenerThreadFunction()
    {
        bool serverStarted = false;
        List<int> portsToTry = new List<int>();

        // Prioritize the current port (for reload scenarios)
        if (currentPort > 0 && !portsToTry.Contains(currentPort))
        {
            portsToTry.Add(currentPort);
        }

        // Then try the last successful port
        if (lastSuccessfulPort > 0 && !portsToTry.Contains(lastSuccessfulPort))
        {
            portsToTry.Add(lastSuccessfulPort);
        }

        // Finally, add all alternative ports
        foreach (int port in ALTERNATIVE_PORTS)
        {
            if (!portsToTry.Contains(port))
            {
                portsToTry.Add(port);
            }
        }

        // Try each port until we find one that works
        foreach (int portToTry in portsToTry)
        {
            // If this is our preferred port (current or last successful), try harder
            bool isPreferredPort = (portToTry == currentPort || portToTry == lastSuccessfulPort);
            int maxAttempts = isPreferredPort ? PORT_RETRY_ATTEMPTS : 1;

            for (int attempt = 0; attempt < maxAttempts; attempt++)
            {
                if (attempt > 0)
                {
                    Thread.Sleep(PORT_RETRY_DELAY_MS);
                }

                try
                {
                    server = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Any, portToTry);

                    // Try to set socket options to allow port reuse
                    try
                    {
                        server.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    }
                    catch (Exception ex)
                    {
                        if (showDebugLogs)
                        {
                            Debug.LogWarning($"Could not set ReuseAddress option: {ex.Message}");
                        }
                    }

                    server.Start();

                    currentPort = portToTry;
                    lastSuccessfulPort = portToTry;
                    // Defer EditorPrefs call to main thread
                    lock (mainThreadActionsLock)
                    {
                        mainThreadActions.Enqueue(() => EditorPrefs.SetInt(lastPortPrefKey, lastSuccessfulPort));
                    }
                    serverStarted = true;

                    Debug.Log($"Unity Hot Reload server listening on port {currentPort}");
                    break;
                }
                catch (SocketException ex)
                {
                    if (ex.ErrorCode == 10048 || ex.ErrorCode == 48 || ex.ErrorCode == 98)
                    {
                        if (showDebugLogs || (isPreferredPort && attempt == maxAttempts - 1))
                        {
                            Debug.LogWarning($"Port {portToTry} is in use (attempt {attempt + 1}/{maxAttempts})");
                        }
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

            if (serverStarted)
                break;
        }

        if (!serverStarted)
        {
            Debug.LogError("Failed to start Hot Reload server. All ports are in use.");
            return;
        }

        isServerRunning = true;
        RunServerLoop();
    }

    /// <summary>
    /// Main server loop extracted to a separate method for reuse.
    /// Handles accepting connections and cleaning up disconnected clients.
    /// </summary>
    private static void RunServerLoop()
    {
        try
        {
            while (isServerRunning)
            {
                try
                {
                    // Wait for a client connection with a timeout
                    if (server.Pending())
                    {
                        TcpClient client = server.AcceptTcpClient();

                        // Add client to list for tracking
                        lock (clientListLock)
                        {
                            connectedClients.Add(client);
                        }

                        // Only log connection if debug logs are enabled
                        if (showDebugLogs)
                        {
                            Debug.Log($"VS Code connected to Unity Hot Reload server on port {currentPort}");
                        }

                        // Handle client in a separate thread to allow multiple connections
                        Thread clientThread = new Thread(() => HandleClient(client));
                        clientThread.IsBackground = true;
                        clientThread.Start();
                    }
                    else
                    {
                        // No pending connections, sleep briefly to avoid busy waiting
                        Thread.Sleep(100);
                    }

                    // Clean up disconnected clients
                    lock (clientListLock)
                    {
                        int removedCount = connectedClients.RemoveAll(c => !c.Connected);
                        if (removedCount > 0 && showDebugLogs)
                        {
                            Debug.Log($"Cleaned up {removedCount} disconnected client(s)");
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
            isServerRunning = false;
        }
    }

    /// <summary>
    /// Handles communication with a single client connection.
    /// </summary>
    /// <param name="client">The connected TCP client</param>
    private static void HandleClient(TcpClient client)
    {
        try
        {
            byte[] buffer = new byte[1024];
            NetworkStream stream = client.GetStream();

            while (client.Connected && isServerRunning)
            {
                if (stream.DataAvailable)
                {
                    int bytesRead = stream.Read(buffer, 0, buffer.Length);
                    if (bytesRead > 0)
                    {
                        string message = Encoding.UTF8.GetString(buffer, 0, bytesRead);

                        // Queue message for processing on main thread
                        lock (messageQueue)
                        {
                            messageQueue.Enqueue(message);
                        }
                    }
                    else
                    {
                        // Connection closed by client
                        break;
                    }
                }
                else
                {
                    // No data available, sleep briefly
                    Thread.Sleep(50);
                }
            }
        }
        catch (Exception ex)
        {
            if (showDebugLogs && isServerRunning)
            {
                Debug.LogWarning($"Client handler error: {ex.Message}");
            }
        }
        finally
        {
            // Remove client from list and close connection
            lock (clientListLock)
            {
                connectedClients.Remove(client);
            }

            try
            {
                client.Close();
            }
            catch { }

            if (showDebugLogs)
            {
                Debug.Log("Client disconnected from Unity Hot Reload server");
            }
        }
    }

    /// <summary>
    /// Processes messages received from the TCP client.
    /// Handles different command types from the VS Code extension.
    /// </summary>
    /// <param name="message">The message received from the client</param>
    private static void ProcessMessage(string message)
    {
        if (showDebugLogs)
        {
            Debug.Log($"Received message: {message}");
        }

        try
        {
            // Try to parse as JSON for more complex commands
            if (message.Contains("{") && message.Contains("}"))
            {
                // Simple JSON parsing for command
                if (message.Contains("\"command\""))
                {
                    if (message.Contains("\"refresh\""))
                    {
                        shouldRequestRefresh = true;
                    }
                    else if (message.Contains("\"ping\""))
                    {
                        // Could implement ping/pong in future
                        if (showDebugLogs)
                        {
                            Debug.Log("Received ping from VS Code");
                        }
                    }
                }
                else
                {
                    // Default behavior - refresh
                    shouldRequestRefresh = true;
                }
            }
            else
            {
                // Simple message - trigger refresh
                shouldRequestRefresh = true;
            }
        }
        catch (Exception ex)
        {
            Debug.LogError($"Error processing message: {ex.Message}");
            // Default to refresh on error
            shouldRequestRefresh = true;
        }
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
    /// Returns -1 if the server is not running.
    /// </summary>
    /// <returns>The current port number or -1 if not running</returns>
    public static int GetCurrentPort()
    {
        return isServerRunning ? currentPort : -1;
    }

    /// <summary>
    /// Checks if the hot reload server is currently running.
    /// </summary>
    /// <returns>True if the server is running, false otherwise</returns>
    public static bool IsServerRunning()
    {
        return isServerRunning;
    }

    /// <summary>
    /// Gets the number of currently connected clients.
    /// </summary>
    /// <returns>The number of connected clients</returns>
    public static int GetConnectedClientCount()
    {
        lock (clientListLock)
        {
            return connectedClients.Count;
        }
    }

    /// <summary>
    /// Tries to start the server on a specific port.
    /// Returns true if successful, false otherwise.
    /// </summary>
    private static bool TryStartOnSpecificPort(int port)
    {
        try
        {
            // Create a new listener thread that will only try the specified port
            listenerThread = new Thread(() => ListenerThreadFunctionSpecificPort(port));
            listenerThread.IsBackground = true;
            listenerThread.Start();

            // Wait a moment to see if it started successfully
            Thread.Sleep(100);

            return isServerRunning;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Special listener thread function that only tries a specific port.
    /// Used for reload scenarios to maintain port consistency.
    /// </summary>
    private static void ListenerThreadFunctionSpecificPort(int specificPort)
    {
        try
        {
            server = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Any, specificPort);

            // Try to set socket options to allow port reuse
            try
            {
                server.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            }
            catch (Exception ex)
            {
                if (showDebugLogs)
                {
                    Debug.LogWarning($"Could not set ReuseAddress option: {ex.Message}");
                }
            }

            server.Start();

            currentPort = specificPort;
            lastSuccessfulPort = specificPort;
            // Defer EditorPrefs call to main thread
            lock (mainThreadActionsLock)
            {
                mainThreadActions.Enqueue(() => EditorPrefs.SetInt(lastPortPrefKey, lastSuccessfulPort));
            }
            isServerRunning = true;
            Debug.Log($"Unity Hot Reload server listening on port {currentPort}");
            RunServerLoop();
        }
        catch (Exception ex)
        {
            if (showDebugLogs)
            {
                Debug.LogError($"Failed to start on port {specificPort}: {ex.Message}");
            }
            isServerRunning = false;
        }
    }
}

#endif // UNITY_EDITOR
