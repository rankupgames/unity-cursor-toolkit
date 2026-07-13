using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Unterm.Editor
{
    /// <summary>
    /// Unity tool catalog for the MCP server. The HTTP/MCP transport itself lives
    /// in the native plugin (so it survives C# domain reloads); this class only
    /// defines the tools, publishes them via <see cref="ToolsJson"/>, and runs
    /// queued calls on the main thread via <see cref="Poll"/>.
    /// </summary>
    internal static class UntermMcpServer
    {
        private sealed class Tool
        {
            public string Name;
            public string Description;
            public JObject InputSchema;
            public Func<JObject, object> Handler; // runs on the main thread
        }

        private static readonly Dictionary<string, Tool> _tools = new();
        private static readonly List<string> _logs = new();
        private static bool _logHooked;

        /// Register default tools once and subscribe to console logs.
        public static void StartLogCapture()
        {
            EnsureTools();
            if (!_logHooked)
            {
                Application.logMessageReceivedThreaded += OnLog;
                _logHooked = true;
            }
        }

        public static void StopLogCapture()
        {
            if (_logHooked)
            {
                Application.logMessageReceivedThreaded -= OnLog;
                _logHooked = false;
            }
        }

        /// The tool catalog as a JSON array for the native MCP server (set_tools).
        public static string ToolsJson()
        {
            EnsureTools();
            if (!UntermMcpSecurity.Enabled) return "[]";
            var arr = new JArray();
            foreach (var t in _tools.Values)
                arr.Add(new JObject
                {
                    ["name"] = t.Name,
                    ["description"] = t.Description + UntermMcpSecurity.DescriptionSuffix(t.Name),
                    ["inputSchema"] = t.InputSchema,
                    ["annotations"] = UntermMcpSecurity.CatalogAnnotations(t.Name),
                });
            return arr.ToString(Formatting.None);
        }

        // Calls whose handler returned an UntermDeferredResult: polled each tick
        // until the result is ready. Lost on a domain reload — the native side
        // then times the call out (~30s), which is the intended backstop.
        private static readonly List<(ulong id, UntermDeferredResult deferred)> _pending = new();

        /// Drain queued tool calls from the native MCP server, run them on the
        /// (current) main thread, and post results back. Call from EditorApplication.update.
        public static void Poll(UntermNative native)
        {
            if (native == null) return;

            // Finish deferred calls whose result is now available.
            for (int i = _pending.Count - 1; i >= 0; i--)
            {
                string result;
                try
                {
                    object r = _pending[i].deferred.Poll();
                    if (r == null) continue; // still pending
                    result = Serialize(r);
                }
                catch (Exception e)
                {
                    result = ToolResult("error: " + e.Message, true);
                }
                native.McpRespond(_pending[i].id, result);
                _pending.RemoveAt(i);
            }

            string callJson;
            while (!string.IsNullOrEmpty(callJson = native.McpNextCall()))
            {
                ulong id = 0;
                string result;
                try
                {
                    var v = JObject.Parse(callJson);
                    id = (ulong)v["id"];
                    string name = (string)v["name"];
                    var args = v["args"] as JObject ?? new JObject();
                    if (!_tools.TryGetValue(name, out var tool))
                        throw new Exception("unknown tool: " + name);
                    if (!UntermMcpSecurity.TryAuthorize(name, args, out string authorizationError))
                    {
                        result = ToolResult("error: " + authorizationError, true);
                        native.McpRespond(id, result);
                        continue;
                    }
                    object r = tool.Handler(args);
                    if (r is UntermDeferredResult deferred)
                    {
                        _pending.Add((id, deferred));
                        continue; // answered later, from the loop above
                    }
                    result = Serialize(r);
                }
                catch (Exception e)
                {
                    result = ToolResult("error: " + e.Message, true);
                }
                native.McpRespond(id, result);
            }
        }

        /// A handler result as the MCP result JSON: a raw {content:[...]} JObject
        /// passes through untouched (e.g. image content from unity_capture);
        /// anything else is serialized and wrapped as text content.
        private static string Serialize(object r)
        {
            if (r is JObject raw && raw["content"] is JArray) return raw.ToString(Formatting.None);
            string text = r as string ?? JsonConvert.SerializeObject(r, Formatting.Indented);
            return ToolResult(text, false);
        }

        private static string ToolResult(string text, bool isError) =>
            new JObject
            {
                ["content"] = new JArray { new JObject { ["type"] = "text", ["text"] = text } },
                ["isError"] = isError,
            }.ToString(Formatting.None);

        private static void OnLog(string condition, string stackTrace, LogType type)
        {
            lock (_logs)
            {
                _logs.Add($"[{type}] {condition}");
                if (_logs.Count > 200) _logs.RemoveAt(0);
            }
        }

        // --- tools ---

        private static void EnsureTools()
        {
            if (_tools.Count > 0) return;
            RegisterBuiltinTools();
            RegisterToolGroups();
        }

        // Discover and register IUntermToolGroup implementors (separate files).
        private static void RegisterToolGroups()
        {
            var sink = new UntermToolSink(Register);
            foreach (var type in TypeCache.GetTypesDerivedFrom<IUntermToolGroup>())
            {
                if (type.IsAbstract || type.IsInterface) continue;
                try
                {
                    var group = (IUntermToolGroup)Activator.CreateInstance(type);
                    group.Register(sink);
                }
                catch (Exception e)
                {
                    Debug.LogError($"[Unterm] tool group {type.Name} failed: {e}");
                }
            }
        }

        private static void RegisterBuiltinTools()
        {

            // unity_editor: live editor state + play/undo control + refresh + tags.
            Register("unity_editor",
                "Query and control the Unity editor. " +
                "action: state (read: play/pause/compiling, active scene, selection, active tool, tags, layers), " +
                "play, pause, stop, undo, redo, refresh (asset import + recompile), " +
                "add_tag, remove_tag (name = tag).",
                Schema(
                    ("action", "string", "state | play | pause | stop | undo | redo | refresh | add_tag | remove_tag",
                        new[] { "state", "play", "pause", "stop", "undo", "redo", "refresh", "add_tag", "remove_tag" }),
                    ("name", "string", "Tag name for add_tag/remove_tag", null)),
                args =>
                {
                    switch ((string)args["action"])
                    {
                        case "play": EditorApplication.isPlaying = true; return new { ok = true, isPlaying = true };
                        case "pause": EditorApplication.isPaused = true; return new { ok = true, isPaused = true };
                        case "stop": EditorApplication.isPlaying = false; return new { ok = true, isPlaying = false };
                        case "undo": Undo.PerformUndo(); return new { ok = true };
                        case "redo": Undo.PerformRedo(); return new { ok = true };
                        case "refresh": AssetDatabase.Refresh(); return new { ok = true };
                        case "add_tag":
                            UnityEditorInternal.InternalEditorUtility.AddTag((string)args["name"]);
                            return new { ok = true, tag = (string)args["name"] };
                        case "remove_tag":
                            UnityEditorInternal.InternalEditorUtility.RemoveTag((string)args["name"]);
                            return new { ok = true, tag = (string)args["name"] };
                        default:
                        {
                            var scene = SceneManager.GetActiveScene();
                            return new
                            {
                                unityVersion = Application.unityVersion,
                                platform = Application.platform.ToString(),
                                isPlaying = EditorApplication.isPlaying,
                                isPaused = EditorApplication.isPaused,
                                // isPlaying alone misses the enter/exit-play window.
                                isChanging = EditorApplication.isPlayingOrWillChangePlaymode,
                                isCompiling = EditorApplication.isCompiling,
                                activeScene = new { scene.name, scene.path },
                                activeTool = Tools.current.ToString(),
                                selection = Selection.gameObjects.Select(g => g.name).Take(20).ToArray(),
                                tags = UnityEditorInternal.InternalEditorUtility.tags,
                                layers = UnityEditorInternal.InternalEditorUtility.layers,
                            };
                        }
                    }
                });

            // unity_scene: active scene info / save.
            Register("unity_scene",
                "Scene operations. action: info (read), hierarchy (read, full tree), save, " +
                "save_as (path), open (path, optional additive), create (path, save the new empty scene).",
                Schema(
                    ("action", "string", "info | hierarchy | save | save_as | open | create",
                        new[] { "info", "hierarchy", "save", "save_as", "open", "create" }),
                    ("path", "string", "Scene asset path (Assets/...) for save_as/open/create", null),
                    ("additive", "boolean", "Open additively (open)", null)),
                args =>
                {
                    var s = SceneManager.GetActiveScene();
                    switch ((string)args["action"])
                    {
                        case "save":
                            return new { ok = EditorSceneManager.SaveScene(s), path = s.path };
                        case "save_as":
                            return new { ok = EditorSceneManager.SaveScene(s, (string)args["path"]), path = (string)args["path"] };
                        case "open":
                        {
                            var mode = ((bool?)args["additive"] ?? false)
                                ? OpenSceneMode.Additive : OpenSceneMode.Single;
                            var opened = EditorSceneManager.OpenScene((string)args["path"], mode);
                            return new { ok = opened.IsValid(), name = opened.name, path = opened.path };
                        }
                        case "create":
                        {
                            var ns = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                            string p = (string)args["path"];
                            bool ok = !string.IsNullOrEmpty(p) && EditorSceneManager.SaveScene(ns, p);
                            return new { ok, path = p };
                        }
                        case "hierarchy":
                            return new { name = s.name, roots = s.GetRootGameObjects().Select(SceneNode).ToArray() };
                        default: // info
                        {
                            var roots = s.GetRootGameObjects();
                            return new
                            {
                                name = s.name,
                                path = s.path,
                                isDirty = s.isDirty,
                                rootCount = roots.Length,
                                roots = roots.Select(g => g.name).ToArray(),
                            };
                        }
                    }
                });

            // unity_gameobject: create / delete / find / select / transform / parent / component / active / duplicate / rename.
            Register("unity_gameobject",
                "Manage GameObjects in the active scene. " +
                "action: find (read), create, delete, select, set_transform, set_parent, " +
                "add_component, set_active, duplicate, rename. " +
                "create accepts name and optional primitive (Cube/Sphere/Capsule/Cylinder/Plane/Quad). " +
                "set_transform accepts position/rotation/scale as [x,y,z] arrays (local space). " +
                "set_parent accepts parent (name, or empty/null to unparent). " +
                "add_component accepts component (type name). rename accepts new_name. set_active accepts active (bool).",
                Schema(
                    ("action", "string", "find | get_info | create | delete | select | set_transform | set_parent | add_component | set_active | duplicate | rename | set_tag | set_layer",
                        new[] { "find", "get_info", "create", "delete", "select", "set_transform", "set_parent", "add_component", "set_active", "duplicate", "rename", "set_tag", "set_layer" }),
                    ("name", "string", "Target/new GameObject name", null),
                    ("primitive", "string", "Primitive type for create (optional)", null),
                    ("position", "array", "[x,y,z] local position (set_transform)", null),
                    ("rotation", "array", "[x,y,z] local euler angles (set_transform)", null),
                    ("scale", "array", "[x,y,z] local scale (set_transform)", null),
                    ("parent", "string", "Parent name for set_parent (empty to unparent)", null),
                    ("component", "string", "Component type name for add_component", null),
                    ("new_name", "string", "New name for rename", null),
                    ("active", "boolean", "Active state for set_active", null),
                    ("tag", "string", "Tag for set_tag", null),
                    ("layer", "string", "Layer name for set_layer", null)),
                args =>
                {
                    string action = (string)args["action"];
                    string name = (string)args["name"];
                    switch (action)
                    {
                        case "create":
                        {
                            GameObject go;
                            string prim = (string)args["primitive"];
                            if (!string.IsNullOrEmpty(prim) && Enum.TryParse<PrimitiveType>(prim, true, out var pt))
                                go = GameObject.CreatePrimitive(pt);
                            else
                                go = new GameObject(string.IsNullOrEmpty(name) ? "GameObject" : name);
                            if (!string.IsNullOrEmpty(name)) go.name = name;
                            Undo.RegisterCreatedObjectUndo(go, "Create " + go.name);
                            return new { ok = true, created = go.name, entityId = go.GetEntityId().ToString() };
                        }
                        case "delete":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            Undo.DestroyObjectImmediate(go);
                            return new { ok = true, deleted = name };
                        }
                        case "select":
                        {
                            var go = FindByName(name);
                            Selection.activeGameObject = go;
                            return new { ok = go != null, selected = go?.name };
                        }
                        case "set_transform":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            Undo.RecordObject(go.transform, "Set Transform");
                            var t = go.transform;
                            if (args["position"] is JArray p) t.localPosition = ToVector3(p, t.localPosition);
                            if (args["rotation"] is JArray r) t.localEulerAngles = ToVector3(r, t.localEulerAngles);
                            if (args["scale"] is JArray sc) t.localScale = ToVector3(sc, t.localScale);
                            return new { ok = true, name = go.name };
                        }
                        case "set_parent":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            string parent = (string)args["parent"];
                            Transform pt = string.IsNullOrEmpty(parent) ? null : FindByName(parent)?.transform;
                            if (!string.IsNullOrEmpty(parent) && pt == null) return NotFound(parent);
                            Undo.SetTransformParent(go.transform, pt, "Set Parent");
                            return new { ok = true, name = go.name, parent = pt?.name };
                        }
                        case "add_component":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            var type = ResolveComponentType((string)args["component"]);
                            if (type == null) return new { ok = false, error = "unknown component: " + (string)args["component"] };
                            Undo.AddComponent(go, type);
                            return new { ok = true, name = go.name, component = type.Name };
                        }
                        case "set_active":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            bool active = (bool?)args["active"] ?? true;
                            Undo.RecordObject(go, "Set Active");
                            go.SetActive(active);
                            return new { ok = true, name = go.name, active };
                        }
                        case "duplicate":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            var clone = UnityEngine.Object.Instantiate(go, go.transform.parent);
                            clone.name = go.name;
                            Undo.RegisterCreatedObjectUndo(clone, "Duplicate");
                            return new { ok = true, duplicated = clone.name };
                        }
                        case "rename":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            Undo.RecordObject(go, "Rename");
                            go.name = (string)args["new_name"] ?? go.name;
                            return new { ok = true, name = go.name };
                        }
                        case "get_info":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            var tr = go.transform;
                            return new
                            {
                                name = go.name,
                                active = go.activeSelf,
                                tag = go.tag,
                                layer = LayerMask.LayerToName(go.layer),
                                path = HierarchyPath(tr),
                                position = new[] { tr.localPosition.x, tr.localPosition.y, tr.localPosition.z },
                                rotation = new[] { tr.localEulerAngles.x, tr.localEulerAngles.y, tr.localEulerAngles.z },
                                scale = new[] { tr.localScale.x, tr.localScale.y, tr.localScale.z },
                                components = go.GetComponents<Component>().Where(c => c != null).Select(c => c.GetType().Name).ToArray(),
                                childCount = tr.childCount,
                            };
                        }
                        case "set_tag":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            Undo.RecordObject(go, "Set Tag");
                            go.tag = (string)args["tag"];
                            return new { ok = true, name = go.name, tag = go.tag };
                        }
                        case "set_layer":
                        {
                            var go = FindByName(name);
                            if (go == null) return NotFound(name);
                            int layer = LayerMask.NameToLayer((string)args["layer"]);
                            if (layer < 0) return new { ok = false, error = "unknown layer: " + (string)args["layer"] };
                            Undo.RecordObject(go, "Set Layer");
                            go.layer = layer;
                            return new { ok = true, name = go.name, layer = (string)args["layer"] };
                        }
                        default: // find
                        {
                            var matches = AllTransforms()
                                .Where(t => string.IsNullOrEmpty(name) || t.name == name)
                                .Select(HierarchyPath).ToArray();
                            return new { count = matches.Length, paths = matches };
                        }
                    }
                });

            // unity_component: list / get / set / remove components on a GameObject.
            Register("unity_component",
                "Inspect and edit components on a GameObject. " +
                "action: list (read, all components), get (read, properties of one component), " +
                "set (a serialized property via path), remove. " +
                "target = GameObject name, component = component type name, " +
                "property = SerializedProperty path (e.g. 'm_Mass'), value = new value.",
                Schema(
                    ("action", "string", "list | get | set | remove", new[] { "list", "get", "set", "remove" }),
                    ("target", "string", "GameObject name", null),
                    ("component", "string", "Component type name", null),
                    ("property", "string", "SerializedProperty path (set)", null),
                    ("value", "string", "New value (set); JSON-typed", null)),
                args =>
                {
                    var go = FindByName((string)args["target"]);
                    if (go == null) return NotFound((string)args["target"]);
                    string action = (string)args["action"];

                    if (action == "list")
                    {
                        var comps = go.GetComponents<Component>()
                            .Where(c => c != null)
                            .Select(c => c.GetType().Name).ToArray();
                        return new { target = go.name, components = comps };
                    }

                    var comp = FindComponent(go, (string)args["component"]);
                    if (comp == null) return new { ok = false, error = "component not found: " + (string)args["component"] };

                    switch (action)
                    {
                        case "remove":
                            Undo.DestroyObjectImmediate(comp);
                            return new { ok = true, removed = (string)args["component"] };
                        case "set":
                        {
                            var so = new SerializedObject(comp);
                            var prop = so.FindProperty((string)args["property"]);
                            if (prop == null) return new { ok = false, error = "property not found: " + (string)args["property"] };
                            Undo.RecordObject(comp, "Set Property");
                            SetProperty(prop, args["value"]);
                            so.ApplyModifiedProperties();
                            return new { ok = true, property = (string)args["property"] };
                        }
                        default: // get
                        {
                            var so = new SerializedObject(comp);
                            var dict = new JObject();
                            var it = so.GetIterator();
                            if (it.NextVisible(true))
                                do { dict[it.propertyPath] = DescribeProperty(it); }
                                while (it.NextVisible(false));
                            return new { component = comp.GetType().Name, properties = dict };
                        }
                    }
                });

            // unity_console: read / clear captured logs.
            Register("unity_console",
                "Unity console logs. action: get (read, optional count), clear.",
                Schema(
                    ("action", "string", "get | clear", new[] { "get", "clear" }),
                    ("count", "integer", "How many recent lines for get (default 50)", null)),
                args =>
                {
                    if ((string)args["action"] == "clear")
                    {
                        lock (_logs) _logs.Clear();
                        return new { ok = true };
                    }
                    int count = (int?)args?["count"] ?? 50;
                    lock (_logs)
                    {
                        int take = Mathf.Clamp(count, 1, Math.Max(1, _logs.Count));
                        return new { lines = _logs.Skip(Math.Max(0, _logs.Count - take)).ToArray() };
                    }
                });

            // unity_menu: execute or search editor menu items.
            Register("unity_menu",
                "Unity editor menu items. action: execute (menu_path, e.g. 'GameObject/Create Empty'), " +
                "search (query -> matching menu paths; use it instead of guessing a path).",
                Schema(
                    ("action", "string", "execute | search", new[] { "execute", "search" }),
                    ("menu_path", "string", "Full menu item path for execute", null),
                    ("query", "string", "Case-insensitive substring for search", null)),
                args =>
                {
                    if ((string)args["action"] == "search")
                    {
                        string q = ((string)args["query"] ?? "").ToLowerInvariant();
                        var paths = AllMenuPaths()
                            .Where(p => p.ToLowerInvariant().Contains(q))
                            .Distinct().OrderBy(p => p).Take(100).ToArray();
                        return new { count = paths.Length, paths };
                    }
                    string path = (string)args["menu_path"];
                    bool ok = !string.IsNullOrEmpty(path) && EditorApplication.ExecuteMenuItem(path);
                    return new { ok, menu_path = path };
                });

            // unity_asset: AssetDatabase operations.
            Register("unity_asset",
                "Project asset operations. action: find (read, by 'filter' like 't:Material' or a name), " +
                "get_info (read, path), create_folder (path), delete (path), move (path -> to), " +
                "duplicate (path -> to), rename (path + name), refresh.",
                Schema(
                    ("action", "string", "find | get_info | create_folder | delete | move | duplicate | rename | refresh",
                        new[] { "find", "get_info", "create_folder", "delete", "move", "duplicate", "rename", "refresh" }),
                    ("filter", "string", "Search filter for find (e.g. 't:Prefab name')", null),
                    ("path", "string", "Asset path (Assets/...)", null),
                    ("to", "string", "Destination path for move/duplicate", null),
                    ("name", "string", "New name for rename", null)),
                args =>
                {
                    switch ((string)args["action"])
                    {
                        case "get_info":
                        {
                            string p = (string)args["path"];
                            var obj = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(p);
                            if (obj == null) return new { ok = false, error = "not found: " + p };
                            return new { path = p, type = obj.GetType().Name, name = obj.name, guid = AssetDatabase.AssetPathToGUID(p) };
                        }
                        case "create_folder":
                        {
                            string p = (string)args["path"];
                            string parent = Path.GetDirectoryName(p)?.Replace('\\', '/');
                            string name = Path.GetFileName(p);
                            string guid = AssetDatabase.CreateFolder(parent, name);
                            return new { ok = !string.IsNullOrEmpty(guid), path = AssetDatabase.GUIDToAssetPath(guid) };
                        }
                        case "delete":
                            return new { ok = AssetDatabase.DeleteAsset((string)args["path"]) };
                        case "move":
                        {
                            string err = AssetDatabase.MoveAsset((string)args["path"], (string)args["to"]);
                            return new { ok = string.IsNullOrEmpty(err), error = err };
                        }
                        case "duplicate":
                            return new { ok = AssetDatabase.CopyAsset((string)args["path"], (string)args["to"]), path = (string)args["to"] };
                        case "rename":
                        {
                            string err = AssetDatabase.RenameAsset((string)args["path"], (string)args["name"]);
                            return new { ok = string.IsNullOrEmpty(err), error = err };
                        }
                        case "refresh":
                            AssetDatabase.Refresh();
                            return new { ok = true };
                        default: // find
                        {
                            var paths = AssetDatabase.FindAssets((string)args["filter"] ?? "")
                                .Select(AssetDatabase.GUIDToAssetPath).Distinct().Take(200).ToArray();
                            return new { count = paths.Length, paths };
                        }
                    }
                });

            // unity_script: create / read / delete / validate C# scripts.
            Register("unity_script",
                "C# script files. action: create (path + content), read (path), delete (path), " +
                "validate (path; fast Roslyn syntax check without waiting for a recompile). " +
                "create/delete trigger an asset import and recompile.",
                Schema(
                    ("action", "string", "create | read | delete | validate", new[] { "create", "read", "delete", "validate" }),
                    ("path", "string", "Assets-relative path (e.g. Assets/Scripts/Foo.cs)", null),
                    ("content", "string", "File content for create", null)),
                args =>
                {
                    string path = (string)args["path"];
                    if (string.IsNullOrEmpty(path)) return new { ok = false, error = "path required" };
                    switch ((string)args["action"])
                    {
                        case "create":
                        {
                            string abs = ToAbsolute(path);
                            Directory.CreateDirectory(Path.GetDirectoryName(abs));
                            File.WriteAllText(abs, (string)args["content"] ?? "");
                            AssetDatabase.ImportAsset(path);
                            return new { ok = true, path };
                        }
                        case "delete":
                            return new { ok = AssetDatabase.DeleteAsset(path) };
                        case "validate":
                        {
                            string abs = ToAbsolute(path);
                            if (!File.Exists(abs)) return new { ok = false, error = "not found: " + path };
                            var diags = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree
                                .ParseText(File.ReadAllText(abs)).GetDiagnostics()
                                .Where(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error)
                                .Select(d => d.ToString()).Take(50).ToArray();
                            return new { ok = diags.Length == 0, diagnostics = diags };
                        }
                        default: // read
                        {
                            string abs = ToAbsolute(path);
                            return File.Exists(abs)
                                ? (object)new { path, content = File.ReadAllText(abs) }
                                : new { ok = false, error = "not found: " + path };
                        }
                    }
                });

            // unity_material: create a material and set shader/color.
            Register("unity_material",
                "Materials. action: create (path + optional shader), set_color (path + color [r,g,b,a], " +
                "optional property name default _BaseColor/color), set_float (path + property + value), " +
                "set_texture (path + property + texture asset path), get_info (read), " +
                "assign (material path -> target GameObject's renderer).",
                Schema(
                    ("action", "string", "create | set_color | set_float | set_texture | get_info | assign",
                        new[] { "create", "set_color", "set_float", "set_texture", "get_info", "assign" }),
                    ("path", "string", "Material asset path (Assets/...)", null),
                    ("shader", "string", "Shader name (default Universal Render Pipeline/Lit)", null),
                    ("color", "array", "[r,g,b,a] 0..1 for set_color", null),
                    ("property", "string", "Shader property name (set_float/set_texture/set_color)", null),
                    ("value", "number", "Float value for set_float", null),
                    ("texture", "string", "Texture asset path for set_texture", null),
                    ("target", "string", "GameObject name for assign", null)),
                args =>
                {
                    string path = (string)args["path"];
                    switch ((string)args["action"])
                    {
                        case "set_float":
                        {
                            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                            if (mat == null) return new { ok = false, error = "material not found: " + path };
                            Undo.RecordObject(mat, "Set Float");
                            mat.SetFloat((string)args["property"], (float?)args["value"] ?? 0f);
                            EditorUtility.SetDirty(mat);
                            return new { ok = true };
                        }
                        case "set_texture":
                        {
                            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                            var tex = AssetDatabase.LoadAssetAtPath<Texture>((string)args["texture"]);
                            if (mat == null || tex == null) return new { ok = false, error = "material or texture not found" };
                            Undo.RecordObject(mat, "Set Texture");
                            mat.SetTexture((string)args["property"] ?? "_BaseMap", tex);
                            EditorUtility.SetDirty(mat);
                            return new { ok = true };
                        }
                        case "get_info":
                        {
                            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                            if (mat == null) return new { ok = false, error = "material not found: " + path };
                            return new { path, shader = mat.shader != null ? mat.shader.name : null, color = new[] { mat.color.r, mat.color.g, mat.color.b, mat.color.a } };
                        }
                        case "create":
                        {
                            string shaderName = (string)args["shader"] ?? "Universal Render Pipeline/Lit";
                            var shader = Shader.Find(shaderName) ?? Shader.Find("Standard");
                            var mat = new Material(shader);
                            AssetDatabase.CreateAsset(mat, path);
                            return new { ok = true, path, shader = shader.name };
                        }
                        case "set_color":
                        {
                            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                            if (mat == null) return new { ok = false, error = "material not found: " + path };
                            if (args["color"] is JArray c && c.Count >= 4)
                            {
                                Undo.RecordObject(mat, "Set Color");
                                mat.color = new Color((float)c[0], (float)c[1], (float)c[2], (float)c[3]);
                                EditorUtility.SetDirty(mat);
                            }
                            return new { ok = true };
                        }
                        case "assign":
                        {
                            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                            var go = FindByName((string)args["target"]);
                            var r = go != null ? go.GetComponent<Renderer>() : null;
                            if (mat == null || r == null) return new { ok = false, error = "material or renderer not found" };
                            Undo.RecordObject(r, "Assign Material");
                            r.sharedMaterial = mat;
                            return new { ok = true };
                        }
                        default:
                            return new { ok = false, error = "unknown action" };
                    }
                });

            // unity_prefab: instantiate / create prefabs.
            Register("unity_prefab",
                "Prefabs. action: instantiate (prefab path -> scene), create (from GameObject 'target' -> path).",
                Schema(
                    ("action", "string", "instantiate | create", new[] { "instantiate", "create" }),
                    ("path", "string", "Prefab asset path (Assets/...)", null),
                    ("target", "string", "GameObject name for create", null)),
                args =>
                {
                    string path = (string)args["path"];
                    if ((string)args["action"] == "create")
                    {
                        var go = FindByName((string)args["target"]);
                        if (go == null) return NotFound((string)args["target"]);
                        var prefab = PrefabUtility.SaveAsPrefabAsset(go, path, out bool ok);
                        return new { ok, path, name = prefab != null ? prefab.name : null };
                    }
                    var asset = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    if (asset == null) return new { ok = false, error = "prefab not found: " + path };
                    var inst = (GameObject)PrefabUtility.InstantiatePrefab(asset);
                    Undo.RegisterCreatedObjectUndo(inst, "Instantiate Prefab");
                    return new { ok = true, instantiated = inst.name };
                });

            // unity_find: find GameObjects by name / tag / component.
            Register("unity_find",
                "Find GameObjects in the active scene. by = name | tag | component, query = the value.",
                Schema(
                    ("by", "string", "name | tag | component", new[] { "name", "tag", "component" }),
                    ("query", "string", "Value to match", null)),
                args =>
                {
                    string by = (string)args["by"];
                    string q = (string)args["query"] ?? "";
                    IEnumerable<Transform> all = AllTransforms();
                    var hits = by switch
                    {
                        "tag" => all.Where(t => SafeTag(t) == q),
                        "component" => all.Where(t => t.GetComponent(q) != null),
                        _ => all.Where(t => t.name == q),
                    };
                    var paths = hits.Select(HierarchyPath).Take(200).ToArray();
                    return new { count = paths.Length, paths };
                });
        }

        // --- helpers ---

        private static GameObject FindByName(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            return AllTransforms().FirstOrDefault(t => t.name == name)?.gameObject;
        }

        private static IEnumerable<Transform> AllTransforms()
        {
            foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                    yield return t;
        }

        private static object NotFound(string name) => new { ok = false, error = "not found: " + name };

        /// Recursive hierarchy node (name + children) for unity_scene hierarchy.
        private static object SceneNode(GameObject go)
        {
            var children = new List<object>();
            foreach (Transform c in go.transform) children.Add(SceneNode(c.gameObject));
            return new { name = go.name, active = go.activeSelf, children };
        }

        /// Convert an Assets-relative path to an absolute filesystem path.
        private static string ToAbsolute(string assetsPath)
        {
            var root = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            return Path.Combine(root, assetsPath.Replace('/', Path.DirectorySeparatorChar));
        }

        /// GameObject.tag throws if the tag is undefined for some objects; guard it.
        private static string SafeTag(Transform t)
        {
            try { return t.tag; } catch { return null; }
        }

        private static Vector3 ToVector3(JArray a, Vector3 fallback)
        {
            if (a == null || a.Count < 3) return fallback;
            return new Vector3((float)a[0], (float)a[1], (float)a[2]);
        }

        /// Resolve a Component subtype by simple or full name across loaded assemblies.
        private static Type ResolveComponentType(string name)
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

        private static Component FindComponent(GameObject go, string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            return go.GetComponents<Component>()
                .FirstOrDefault(c => c != null && (c.GetType().Name == typeName || c.GetType().FullName == typeName));
        }

        private static JToken DescribeProperty(SerializedProperty p)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: return p.intValue;
                case SerializedPropertyType.Boolean: return p.boolValue;
                case SerializedPropertyType.Float: return p.floatValue;
                case SerializedPropertyType.String: return p.stringValue;
                case SerializedPropertyType.Enum: return p.enumValueIndex;
                case SerializedPropertyType.Vector3:
                    return new JArray(p.vector3Value.x, p.vector3Value.y, p.vector3Value.z);
                case SerializedPropertyType.Vector2:
                    return new JArray(p.vector2Value.x, p.vector2Value.y);
                case SerializedPropertyType.Color:
                    return new JArray(p.colorValue.r, p.colorValue.g, p.colorValue.b, p.colorValue.a);
                case SerializedPropertyType.ObjectReference:
                    return p.objectReferenceValue != null ? p.objectReferenceValue.name : null;
                default:
                    return p.propertyType.ToString();
            }
        }

        private static void SetProperty(SerializedProperty p, JToken value)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: p.intValue = (int)value; break;
                case SerializedPropertyType.Boolean: p.boolValue = (bool)value; break;
                case SerializedPropertyType.Float: p.floatValue = (float)value; break;
                case SerializedPropertyType.String: p.stringValue = (string)value; break;
                case SerializedPropertyType.Enum: p.enumValueIndex = (int)value; break;
                case SerializedPropertyType.Vector3:
                    if (value is JArray v3 && v3.Count >= 3) p.vector3Value = new Vector3((float)v3[0], (float)v3[1], (float)v3[2]);
                    break;
                case SerializedPropertyType.Vector2:
                    if (value is JArray v2 && v2.Count >= 2) p.vector2Value = new Vector2((float)v2[0], (float)v2[1]);
                    break;
                case SerializedPropertyType.Color:
                    if (value is JArray c && c.Count >= 4) p.colorValue = new Color((float)c[0], (float)c[1], (float)c[2], (float)c[3]);
                    break;
                default:
                    throw new Exception($"unsupported property type: {p.propertyType}");
            }
        }

        private static string HierarchyPath(Transform t)
        {
            var sb = new StringBuilder(t.name);
            for (var p = t.parent; p != null; p = p.parent) sb.Insert(0, p.name + "/");
            return sb.ToString();
        }

        /// Build a JSON-Schema object from (name, type, description, enumValues?) tuples.
        /// The first parameter is treated as required.
        private static JObject Schema(params (string name, string type, string desc, string[] options)[] props)
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

        /// Every known menu item path: script-defined [MenuItem]s via TypeCache,
        /// plus built-in menus via the internal Menu.ExtractSubmenus (reflection;
        /// silently absent if the internal API moves).
        private static IEnumerable<string> AllMenuPaths()
        {
            foreach (var m in TypeCache.GetMethodsWithAttribute<MenuItem>())
                foreach (MenuItem a in m.GetCustomAttributes(typeof(MenuItem), false))
                    if (!a.validate)
                        yield return a.menuItem;

            var extract = typeof(Menu).GetMethod("ExtractSubmenus",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            if (extract == null) yield break;
            foreach (var top in new[] { "File", "Edit", "Assets", "GameObject", "Component", "Tools", "Window", "Help" })
            {
                string[] subs = null;
                try { subs = extract.Invoke(null, new object[] { top }) as string[]; }
                catch (Exception e) { UntermLog.WarnOnce("menu.extractSubmenus", e); }
                if (subs == null) continue;
                foreach (var s in subs) yield return s;
            }
        }

        private static void Register(string name, string description, JObject schema, Func<JObject, object> handler)
        {
            _tools[name] = new Tool
            {
                Name = name,
                Description = description,
                InputSchema = schema,
                Handler = handler,
            };
        }
    }
}
