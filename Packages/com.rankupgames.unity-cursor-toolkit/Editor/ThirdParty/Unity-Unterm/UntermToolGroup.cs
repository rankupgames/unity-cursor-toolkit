using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Unterm.Editor
{
    /// <summary>
    /// Implement this on a class to contribute MCP tools. UntermMcpServer
    /// discovers all implementors via reflection and calls Register once.
    /// Each tool is action-based; handlers run on the Unity main thread and
    /// return any object (serialized to JSON) or a string.
    /// </summary>
    internal interface IUntermToolGroup
    {
        void Register(UntermToolSink tools);
    }

    /// <summary>Registration surface passed to tool groups.</summary>
    internal sealed class UntermToolSink
    {
        private readonly Action<string, string, JObject, Func<JObject, object>> _add;

        public UntermToolSink(Action<string, string, JObject, Func<JObject, object>> add) => _add = add;

        /// <summary>Register a tool (name, description, JSON-Schema, handler).</summary>
        public void Add(string name, string description, JObject inputSchema, Func<JObject, object> handler) =>
            _add(name, description, inputSchema, handler);

        /// <summary>
        /// Build a JSON-Schema object from (name, type, description, enumValues?)
        /// tuples. The first property is marked required.
        /// </summary>
        public JObject Schema(params (string name, string type, string desc, string[] options)[] props)
        {
            var properties = new JObject();
            foreach (var p in props)
            {
                var def = new JObject { ["type"] = p.type, ["description"] = p.desc };
                if (p.options != null) def["enum"] = new JArray(p.options);
                properties[p.name] = def;
            }
            return new JObject
            {
                ["type"] = "object",
                ["properties"] = properties,
                ["required"] = props.Length > 0 ? new JArray(props[0].name) : new JArray(),
            };
        }
    }

    /// <summary>
    /// Returned by a tool handler to defer its result (e.g. an async Package
    /// Manager request): UntermMcpServer polls <see cref="Poll"/> on the main
    /// thread each editor tick until it returns the final (non-null) result.
    /// The native side times the call out (~30s), which bounds a stuck poll.
    /// </summary>
    internal sealed class UntermDeferredResult
    {
        public Func<object> Poll;
    }

    /// <summary>Shared helpers for tool handlers.</summary>
    internal static class UntermToolUtil
    {
        public static object NotFound(string name) => new { ok = false, error = "not found: " + name };

        public static GameObject FindByName(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            return AllTransforms().FirstOrDefault(t => t.name == name)?.gameObject;
        }

        public static IEnumerable<Transform> AllTransforms()
        {
            foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                    yield return t;
        }

        public static string HierarchyPath(Transform t)
        {
            var sb = new StringBuilder(t.name);
            for (var p = t.parent; p != null; p = p.parent) sb.Insert(0, p.name + "/");
            return sb.ToString();
        }

        public static Vector3 ToVector3(JArray a, Vector3 fallback)
        {
            if (a == null || a.Count < 3) return fallback;
            return new Vector3((float)a[0], (float)a[1], (float)a[2]);
        }

        /// Resolve a Component subtype by simple or full name across loaded assemblies.
        public static Type ResolveComponentType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); } catch { continue; }
                foreach (var t in types)
                {
                    if (!typeof(Component).IsAssignableFrom(t)) continue;
                    if (t.Name == name || t.FullName == name) return t;
                }
            }
            return null;
        }

        /// Resolve any type by simple or full name across loaded assemblies.
        public static Type ResolveType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); } catch { continue; }
                foreach (var t in types)
                    if (t.Name == name || t.FullName == name) return t;
            }
            return null;
        }

        /// Convert an Assets-relative path to an absolute filesystem path.
        public static string ToAbsolute(string assetsPath)
        {
            var root = System.IO.Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            return System.IO.Path.Combine(root, assetsPath.Replace('/', System.IO.Path.DirectorySeparatorChar));
        }
    }
}
