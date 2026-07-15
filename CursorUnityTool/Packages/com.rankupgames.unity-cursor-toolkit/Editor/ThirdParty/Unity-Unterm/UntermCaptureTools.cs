using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Unterm.Editor
{
    /// <summary>
    /// Screenshot tool so the agent can SEE the project: render a Game camera or
    /// the Scene view into a PNG and return it as MCP image content (the raw
    /// {content:[...]} shape passes through UntermMcpServer.Poll untouched).
    /// </summary>
    internal sealed class UntermCaptureTools : IUntermToolGroup
    {
        public void Register(UntermToolSink t)
        {
            t.Add(
                "unity_capture",
                "Capture a screenshot as an image. target: game (a camera's view; optional camera name, " +
                "defaults to the main camera) or scene (the Scene view). " +
                "Optional width/height (default 960x540, clamped to 64-2048). Use it to check what a scene actually looks like.",
                t.Schema(
                    ("target", "string", "game | scene", new[] { "game", "scene" }),
                    ("camera", "string", "Camera name for game (default: main camera)", null),
                    ("width", "integer", "Image width (default 960, clamped to 64-2048)", null),
                    ("height", "integer", "Image height (default 540, clamped to 64-2048)", null)),
                args =>
                {
                    int w = Mathf.Clamp((int?)args["width"] ?? 960, 64, 2048);
                    int h = Mathf.Clamp((int?)args["height"] ?? 540, 64, 2048);

                    Camera cam;
                    if ((string)args["target"] == "scene")
                    {
                        cam = SceneView.lastActiveSceneView != null ? SceneView.lastActiveSceneView.camera : null;
                        if (cam == null) return new { ok = false, error = "no active Scene view" };
                    }
                    else
                    {
                        string name = (string)args["camera"];
                        cam = string.IsNullOrEmpty(name)
                            ? (Camera.main != null ? Camera.main : Camera.allCameras.FirstOrDefault())
                            : Camera.allCameras.FirstOrDefault(c => c.name == name);
                        if (cam == null)
                            return new { ok = false, error = "no camera found" + (string.IsNullOrEmpty(name) ? "" : ": " + name) };
                    }

                    byte[] png = RenderToPng(cam, w, h);
                    return new JObject
                    {
                        ["content"] = new JArray
                        {
                            new JObject { ["type"] = "image", ["data"] = Convert.ToBase64String(png), ["mimeType"] = "image/png" },
                            new JObject { ["type"] = "text", ["text"] = $"{cam.name} {w}x{h}" },
                        },
                        ["isError"] = false,
                    };
                });
        }

        /// Render one frame of `cam` into a temporary RenderTexture and encode a PNG,
        /// restoring the camera's target and the active RenderTexture afterwards.
        private static byte[] RenderToPng(Camera cam, int w, int h)
        {
            var rt = RenderTexture.GetTemporary(w, h, 24);
            var prevTarget = cam.targetTexture;
            var prevActive = RenderTexture.active;
            try
            {
                var request = new RenderPipeline.StandardRequest();
                if (RenderPipeline.SupportsRenderRequest(cam, request))
                {
                    // SRP (URP/HDRP): Camera.Render() is unsupported there, so
                    // go through the render-request API instead.
                    request.destination = rt;
                    RenderPipeline.SubmitRenderRequest(cam, request);
                }
                else
                {
                    cam.targetTexture = rt;
                    cam.Render();
                }
                RenderTexture.active = rt;
                var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                try { return tex.EncodeToPNG(); }
                finally { UnityEngine.Object.DestroyImmediate(tex); }
            }
            finally
            {
                cam.targetTexture = prevTarget;
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
            }
        }
    }
}
