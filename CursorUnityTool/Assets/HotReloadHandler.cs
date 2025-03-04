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
    private static readonly int Port = 55500;
    private static readonly Queue<string> messageQueue = new Queue<string>();
    private static bool isInitialized = false;

    // Static constructor called when Unity editor loads
    static HotReloadHandler()
    {
        Initialize();
    }

    [MenuItem("Tools/Hot Reload/Start Server")]
    public static void Initialize()
    {
        if (isInitialized)
            return;

        Debug.Log("Starting Unity Hot Reload server...");
        
        // Register for update events
        EditorApplication.update += OnEditorUpdate;
        
        // Start TCP listener thread
        listenerThread = new Thread(ListenerThreadFunction);
        listenerThread.IsBackground = true;
        listenerThread.Start();
        
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
        
        // Stop TCP listener
        if (server != null)
        {
            server.Stop();
            server = null;
        }
        
        // Stop thread
        if (listenerThread != null && listenerThread.IsAlive)
        {
            listenerThread.Abort();
            listenerThread = null;
        }
        
        isInitialized = false;
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
        try
        {
            server = new TcpListener(IPAddress.Parse("127.0.0.1"), Port);
            server.Start();
            
            Debug.Log($"Unity Hot Reload server listening on port {Port}");

            // Buffer for reading data
            byte[] bytes = new byte[1024];
            
            while (true)
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
        }
        catch (ThreadAbortException)
        {
            Debug.Log("Unity Hot Reload server thread aborted");
        }
        catch (Exception e)
        {
            Debug.LogError($"Unity Hot Reload server error: {e.Message}");
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
} 