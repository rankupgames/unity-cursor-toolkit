/*
 * ViewportServiceServer.cs
 *
 * Runtime-only player bridge for the Unity Cursor Toolkit viewport service.
 * It speaks the same newline-delimited JSON subset as the editor bridge:
 * ping/pong, mcpToolCall viewport_stream, mcpToolResult, and viewportFrame.
 */

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

using UnityEngine;
using UnityEngine.Rendering;

namespace UnityCursorToolkit.ViewportService
{

public sealed class ViewportServiceServer : MonoBehaviour
{
    private const int DefaultPort = 55500;

    private readonly List<TcpClient> clients = new List<TcpClient>();
    private readonly object clientsLock = new object();
    private readonly Queue<string> messages = new Queue<string>();
    private readonly object messagesLock = new object();
    private readonly Dictionary<string, StreamSession> sessions = new Dictionary<string, StreamSession>();

    private TcpListener listener;
    private Thread listenerThread;
    private volatile bool running;
    private Camera serviceCamera;
    private Transform orbitTarget;
    private float yaw = 40f;
    private float pitch = 28f;
    private float distance = 7f;

    private void Awake()
    {
        Application.runInBackground = true;
        QualitySettings.vSyncCount = 0;
        Application.targetFrameRate = 60;
        EnsureScene();
    }

    private void Start()
    {
        StartServer(ReadPortArg());
    }

    private void Update()
    {
        DrainMessages();
        UpdateCameraRig();
        TickSessions();
    }

    private void OnDestroy()
    {
        StopServer();
        foreach (StreamSession session in sessions.Values)
        {
            session.Dispose();
        }
        sessions.Clear();
    }

    private int ReadPortArg()
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-uctViewportPort" && int.TryParse(args[i + 1], out int parsed) && parsed > 0 && parsed < 65536)
            {
                return parsed;
            }
        }
        return DefaultPort;
    }

    private void StartServer(int port)
    {
        if (running)
        {
            return;
        }

        running = true;
        listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        listenerThread = new Thread(ListenLoop);
        listenerThread.IsBackground = true;
        listenerThread.Start();
        Debug.Log($"Viewport Service listening on 127.0.0.1:{port}");
    }

    private void StopServer()
    {
        running = false;
        try { listener?.Stop(); } catch (Exception) { }
        listener = null;

        lock (clientsLock)
        {
            foreach (TcpClient client in clients)
            {
                try { client.Close(); } catch (Exception) { }
            }
            clients.Clear();
        }
    }

    private void ListenLoop()
    {
        while (running)
        {
            try
            {
                TcpClient client = listener.AcceptTcpClient();
                lock (clientsLock)
                {
                    clients.Add(client);
                }

                Thread thread = new Thread(() => ClientLoop(client));
                thread.IsBackground = true;
                thread.Start();
            }
            catch (SocketException)
            {
                if (running)
                {
                    Debug.LogWarning("Viewport Service accept failed.");
                }
            }
            catch (ObjectDisposedException)
            {
                break;
            }
        }
    }

    private void ClientLoop(TcpClient client)
    {
        byte[] buffer = new byte[8192];
        StringBuilder lineBuffer = new StringBuilder();

        try
        {
            NetworkStream stream = client.GetStream();
            while (running && client.Connected)
            {
                if (stream.DataAvailable == false)
                {
                    Thread.Sleep(10);
                    continue;
                }

                int read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0)
                {
                    break;
                }

                lineBuffer.Append(Encoding.UTF8.GetString(buffer, 0, read));
                string text = lineBuffer.ToString();
                int newline;
                while ((newline = text.IndexOf('\n')) >= 0)
                {
                    string line = text.Substring(0, newline).Trim();
                    text = text.Substring(newline + 1);
                    if (line.Length > 0)
                    {
                        lock (messagesLock)
                        {
                            messages.Enqueue(line);
                        }
                    }
                }

                lineBuffer.Length = 0;
                lineBuffer.Append(text);
            }
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"Viewport Service client failed: {ex.Message}");
        }
        finally
        {
            lock (clientsLock)
            {
                clients.Remove(client);
            }
            try { client.Close(); } catch (Exception) { }
        }
    }

    private void DrainMessages()
    {
        while (true)
        {
            string message = null;
            lock (messagesLock)
            {
                if (messages.Count > 0)
                {
                    message = messages.Dequeue();
                }
            }

            if (message == null)
            {
                return;
            }

            ProcessMessage(message);
        }
    }

    private void ProcessMessage(string message)
    {
        string command = JsonText.GetString(message, "command");
        switch (command)
        {
            case "ping":
                Broadcast("{\"command\":\"pong\"}");
                break;
            case "mcpToolCall":
                HandleToolCall(message);
                break;
            default:
                Debug.Log($"Viewport Service ignored command: {command}");
                break;
        }
    }

    private void HandleToolCall(string message)
    {
        string requestId = JsonText.GetString(message, "_requestId");
        string toolName = JsonText.GetString(message, "toolName");
        string args = JsonText.GetObject(message, "args") ?? "{}";

        if (toolName != "viewport_stream")
        {
            SendToolResult(requestId, "{\"success\":false,\"error\":\"Unsupported player tool\"}");
            return;
        }

        string action = JsonText.GetString(args, "action", "status");
        switch (action)
        {
            case "start":
                StartStream(requestId, args);
                break;
            case "stop":
                StopStream(requestId, args);
                break;
            case "status":
                SendToolResult(requestId, $"{{\"success\":true,\"host\":\"player\",\"sessions\":{sessions.Count}}}");
                break;
            case "input":
                HandleInput(requestId, args);
                break;
            default:
                SendToolResult(requestId, $"{{\"success\":false,\"error\":\"Unknown viewport_stream action: {JsonText.Escape(action)}\"}}");
                break;
        }
    }

    private void StartStream(string requestId, string args)
    {
        string sessionId = JsonText.GetString(args, "sessionId", $"player_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
        string view = JsonText.GetString(args, "view", "scene");
        int width = JsonText.GetInt(args, "width", 1280);
        int height = JsonText.GetInt(args, "height", 720);
        int fps = Mathf.Clamp(JsonText.GetInt(args, "fps", view == "game" ? 30 : 12), 1, 60);
        int quality = Mathf.Clamp(JsonText.GetInt(args, "quality", 70), 1, 100);

        if (sessions.TryGetValue(sessionId, out StreamSession existing))
        {
            existing.Dispose();
            sessions.Remove(sessionId);
        }

        StreamSession session = new StreamSession(sessionId, view, width, height, fps, quality, serviceCamera);
        sessions.Add(sessionId, session);
        SendToolResult(requestId, $"{{\"success\":true,\"host\":\"player\",\"captureMode\":\"camera\",\"sessionId\":\"{JsonText.Escape(sessionId)}\",\"view\":\"{JsonText.Escape(view)}\",\"fps\":{fps},\"width\":{width},\"height\":{height}}}");
    }

    private void StopStream(string requestId, string args)
    {
        string sessionId = JsonText.GetString(args, "sessionId", "");
        if (string.IsNullOrEmpty(sessionId))
        {
            foreach (StreamSession session in sessions.Values)
            {
                session.Dispose();
            }
            sessions.Clear();
        }
        else if (sessions.TryGetValue(sessionId, out StreamSession session))
        {
            session.Dispose();
            sessions.Remove(sessionId);
        }

        SendToolResult(requestId, "{\"success\":true,\"host\":\"player\"}");
    }

    private void HandleInput(string requestId, string args)
    {
        string inputType = JsonText.GetString(args, "inputType", "");
        if (inputType == "sceneDrag")
        {
            float dx = JsonText.GetFloat(args, "dx", JsonText.GetFloat(args, "x2", 0f) - JsonText.GetFloat(args, "x", 0f));
            float dy = JsonText.GetFloat(args, "dy", JsonText.GetFloat(args, "y2", 0f) - JsonText.GetFloat(args, "y", 0f));
            yaw += dx * 0.2f;
            pitch = Mathf.Clamp(pitch - dy * 0.2f, -80f, 80f);
        }
        else if (inputType == "sceneZoom" || inputType == "wheel")
        {
            float delta = JsonText.GetFloat(args, "wheelDelta", JsonText.GetFloat(args, "delta", 0f));
            distance = Mathf.Clamp(distance + delta * 0.01f, 1.5f, 40f);
        }

        SendToolResult(requestId, $"{{\"success\":true,\"host\":\"player\",\"layer\":\"runtime\",\"inputType\":\"{JsonText.Escape(inputType)}\"}}");
    }

    private void TickSessions()
    {
        float now = Time.unscaledTime;
        foreach (StreamSession session in sessions.Values)
        {
            if (session.IsCaptureDue(now))
            {
                session.MarkCaptureStarted(now);
                CaptureFrame(session);
            }
        }
    }

    private void CaptureFrame(StreamSession session)
    {
        Camera camera = session.Camera;
        RenderTexture previousActive = RenderTexture.active;
        RenderTexture previousTarget = camera.targetTexture;

        camera.targetTexture = session.RenderTexture;
        RenderTexture.active = session.RenderTexture;
        camera.Render();
        camera.targetTexture = previousTarget;
        RenderTexture.active = previousActive;

        AsyncGPUReadback.Request(session.RenderTexture, 0, TextureFormat.RGBA32, request =>
        {
            if (request.hasError || session.Disposed)
            {
                return;
            }

            try
            {
                session.Texture.LoadRawTextureData(request.GetData<byte>());
                session.Texture.Apply(false);
                byte[] jpg = session.Texture.EncodeToJPG(session.Quality);
                string data = Convert.ToBase64String(jpg);
                int sequence = session.NextSequence();
                string timestamp = DateTime.UtcNow.ToString("O");
                Broadcast($"{{\"command\":\"viewportFrame\",\"sessionId\":\"{JsonText.Escape(session.SessionId)}\",\"host\":\"player\",\"view\":\"{JsonText.Escape(session.View)}\",\"captureMode\":\"camera\",\"sequence\":{sequence},\"width\":{session.Width},\"height\":{session.Height},\"timestamp\":\"{timestamp}\",\"data\":\"{data}\"}}");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"Viewport Service capture failed: {ex.Message}");
            }
        });
    }

    private void SendToolResult(string requestId, string resultJson)
    {
        string id = string.IsNullOrEmpty(requestId) ? "" : $",\"_requestId\":\"{JsonText.Escape(requestId)}\"";
        Broadcast($"{{\"command\":\"mcpToolResult\"{id},\"result\":{resultJson}}}");
    }

    private void Broadcast(string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (clientsLock)
        {
            for (int i = clients.Count - 1; i >= 0; i--)
            {
                TcpClient client = clients[i];
                try
                {
                    if (client.Connected == false)
                    {
                        clients.RemoveAt(i);
                        continue;
                    }
                    client.GetStream().Write(bytes, 0, bytes.Length);
                }
                catch (Exception)
                {
                    clients.RemoveAt(i);
                    try { client.Close(); } catch (Exception) { }
                }
            }
        }
    }

    private void EnsureScene()
    {
        serviceCamera = Camera.main;
        if (serviceCamera == null)
        {
            GameObject cameraObject = new GameObject("Viewport Service Camera");
            serviceCamera = cameraObject.AddComponent<Camera>();
            cameraObject.tag = "MainCamera";
        }

        serviceCamera.clearFlags = CameraClearFlags.Skybox;
        serviceCamera.fieldOfView = 55f;
        serviceCamera.nearClipPlane = 0.03f;
        serviceCamera.farClipPlane = 200f;

        GameObject target = GameObject.Find("Viewport Service Target");
        if (target == null)
        {
            target = GameObject.CreatePrimitive(PrimitiveType.Cube);
            target.name = "Viewport Service Target";
            target.transform.position = Vector3.zero;
        }
        orbitTarget = target.transform;

        if (UnityEngine.Object.FindFirstObjectByType<Light>() == null)
        {
            GameObject lightObject = new GameObject("Viewport Service Directional Light");
            Light light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.2f;
            lightObject.transform.rotation = Quaternion.Euler(50f, -35f, 0f);
        }

        if (GameObject.Find("Viewport Service Grid") == null)
        {
            CreateGrid();
        }
        UpdateCameraRig();
    }

    private void CreateGrid()
    {
        GameObject root = new GameObject("Viewport Service Grid");
        Material material = new Material(Shader.Find("Sprites/Default"));
        material.color = new Color(0.22f, 0.28f, 0.34f, 1f);

        int size = 20;
        for (int i = -size; i <= size; i++)
        {
            CreateGridLine(root.transform, material, new Vector3(i, -0.01f, -size), new Vector3(i, -0.01f, size));
            CreateGridLine(root.transform, material, new Vector3(-size, -0.01f, i), new Vector3(size, -0.01f, i));
        }
    }

    private void CreateGridLine(Transform parent, Material material, Vector3 a, Vector3 b)
    {
        GameObject lineObject = new GameObject("Grid Line");
        lineObject.transform.SetParent(parent, false);
        LineRenderer line = lineObject.AddComponent<LineRenderer>();
        line.sharedMaterial = material;
        line.positionCount = 2;
        line.SetPosition(0, a);
        line.SetPosition(1, b);
        line.startWidth = 0.01f;
        line.endWidth = 0.01f;
        line.useWorldSpace = true;
    }

    private void UpdateCameraRig()
    {
        if (serviceCamera == null || orbitTarget == null)
        {
            return;
        }

        Quaternion rotation = Quaternion.Euler(pitch, yaw, 0f);
        Vector3 target = orbitTarget.position;
        serviceCamera.transform.position = target + rotation * new Vector3(0f, 0f, -distance);
        serviceCamera.transform.rotation = rotation;
    }

    private sealed class StreamSession : IDisposable
    {
        public readonly string SessionId;
        public readonly string View;
        public readonly int Width;
        public readonly int Height;
        public readonly int Fps;
        public readonly int Quality;
        public readonly Camera Camera;
        public readonly RenderTexture RenderTexture;
        public readonly Texture2D Texture;

        private int sequence;
        private float nextCaptureTime;

        public bool Disposed { get; private set; }

        public StreamSession(string sessionId, string view, int width, int height, int fps, int quality, Camera camera)
        {
            SessionId = sessionId;
            View = view;
            Width = Mathf.Clamp(width, 160, 3840);
            Height = Mathf.Clamp(height, 90, 2160);
            Fps = Mathf.Clamp(fps, 1, 60);
            Quality = Mathf.Clamp(quality, 1, 100);
            Camera = camera;
            RenderTexture = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32);
            Texture = new Texture2D(Width, Height, TextureFormat.RGBA32, false);
            nextCaptureTime = 0f;
        }

        public bool IsCaptureDue(float now)
        {
            return Disposed == false && now >= nextCaptureTime;
        }

        public void MarkCaptureStarted(float now)
        {
            nextCaptureTime = now + 1f / Fps;
        }

        public int NextSequence()
        {
            sequence += 1;
            return sequence;
        }

        public void Dispose()
        {
            Disposed = true;
            if (RenderTexture != null)
            {
                RenderTexture.Release();
                UnityEngine.Object.Destroy(RenderTexture);
            }
            if (Texture != null)
            {
                UnityEngine.Object.Destroy(Texture);
            }
        }
    }
}

internal static class JsonText
{
    public static string GetString(string json, string key, string fallback = null)
    {
        string search = "\"" + key + "\"";
        int keyIndex = json.IndexOf(search, StringComparison.Ordinal);
        if (keyIndex < 0)
        {
            return fallback;
        }

        int colon = json.IndexOf(':', keyIndex + search.Length);
        if (colon < 0)
        {
            return fallback;
        }

        int quoteStart = json.IndexOf('"', colon + 1);
        if (quoteStart < 0)
        {
            return fallback;
        }

        StringBuilder value = new StringBuilder();
        bool escaped = false;
        for (int i = quoteStart + 1; i < json.Length; i++)
        {
            char c = json[i];
            if (escaped)
            {
                value.Append(c);
                escaped = false;
                continue;
            }
            if (c == '\\')
            {
                escaped = true;
                continue;
            }
            if (c == '"')
            {
                return value.ToString();
            }
            value.Append(c);
        }

        return fallback;
    }

    public static int GetInt(string json, string key, int fallback)
    {
        return int.TryParse(GetNumberText(json, key), out int value) ? value : fallback;
    }

    public static float GetFloat(string json, string key, float fallback)
    {
        return float.TryParse(GetNumberText(json, key), out float value) ? value : fallback;
    }

    public static string GetObject(string json, string key)
    {
        string search = "\"" + key + "\"";
        int keyIndex = json.IndexOf(search, StringComparison.Ordinal);
        if (keyIndex < 0)
        {
            return null;
        }

        int braceStart = json.IndexOf('{', keyIndex + search.Length);
        if (braceStart < 0)
        {
            return null;
        }

        int depth = 0;
        bool inString = false;
        bool escaped = false;
        for (int i = braceStart; i < json.Length; i++)
        {
            char c = json[i];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (c == '\\')
            {
                escaped = true;
                continue;
            }
            if (c == '"')
            {
                inString = !inString;
                continue;
            }
            if (inString)
            {
                continue;
            }
            if (c == '{')
            {
                depth++;
            }
            else if (c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return json.Substring(braceStart, i - braceStart + 1);
                }
            }
        }

        return null;
    }

    public static string Escape(string value)
    {
        if (value == null)
        {
            return "";
        }
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static string GetNumberText(string json, string key)
    {
        string search = "\"" + key + "\"";
        int keyIndex = json.IndexOf(search, StringComparison.Ordinal);
        if (keyIndex < 0)
        {
            return "";
        }

        int colon = json.IndexOf(':', keyIndex + search.Length);
        if (colon < 0)
        {
            return "";
        }

        int start = colon + 1;
        while (start < json.Length && char.IsWhiteSpace(json[start]))
        {
            start++;
        }

        int end = start;
        while (end < json.Length && "-+.0123456789".IndexOf(json[end]) >= 0)
        {
            end++;
        }

        return json.Substring(start, end - start);
    }
}

}
