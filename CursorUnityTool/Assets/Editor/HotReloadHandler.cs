using UnityEngine;
using UnityEditor;
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Text;
using System.Collections.Generic;
#if UNITY_2019_1_OR_NEWER
using UnityEditor.Compilation;
#endif

[InitializeOnLoad]
public class HotReloadHandler : EditorWindow
{
    private static TcpListener server;
    private static Thread listenerThread;
    private static bool shouldRequestRefresh = false;
    private static int port = 55500;
    private static readonly Queue<string> messageQueue = new Queue<string>();
    private static bool isInitialized = false;
    private static bool isServerRunning = false;
    
    // Used to check if we're already running
    private static Mutex instanceMutex;

    // Static constructor called when Unity editor loads
    static HotReloadHandler()
    {
        // Register for domain reload completion to restart the server
        EditorApplication.update += OnEditorUpdate;
        
        // Register shutdown handler
        AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
        EditorApplication.quitting += OnEditorQuitting;
        
        Initialize();
    }

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
                    listenerThread.Abort();
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Error stopping thread: {ex.Message}");
            }
            
            listenerThread = null;
        }
    }

    // Clean up when Unity is about to reload scripts
    private static void OnBeforeAssemblyReload()
    {
        StopServer();
    }
    
    // Clean up when Unity is quitting
    private static void OnEditorQuitting()
    {
        Shutdown();
    }

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

    private static void ListenerThreadFunction()
    {
        // Try multiple ports if necessary
        int[] portsToTry = new int[] { port, 55501, 55502, 55503, 55504 };
        bool serverStarted = false;
        
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
        
        try
        {
            // Buffer for reading data
            byte[] bytes = new byte[1024];
            
            while (isServerRunning)
            {
                try
                {
                    using (TcpClient client = server.AcceptTcpClient())
                    {
                        Debug.Log("VS Code connected to Unity Hot Reload server");
                        
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
            Debug.Log("Unity Hot Reload server thread aborted");
        }
        catch (Exception e)
        {
            if (!isServerRunning)
            {
                // Server is shutting down, this is expected
                Debug.Log("Unity Hot Reload server stopped");
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

    private static void ProcessMessage(string message)
    {
        Debug.Log($"Received message: {message}");
        
        // Simple protocol - any message triggers a refresh
        shouldRequestRefresh = true;
    }

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
            
            Debug.Log("Hot Reload: Refresh complete");
        }
        catch (Exception e)
        {
            Debug.LogError($"Hot Reload refresh error: {e.Message}");
        }
    }
    
    // Helper method to get the active port - can be useful for other parts of the system
    public static int GetPort()
    {
        return port;
    }
} 