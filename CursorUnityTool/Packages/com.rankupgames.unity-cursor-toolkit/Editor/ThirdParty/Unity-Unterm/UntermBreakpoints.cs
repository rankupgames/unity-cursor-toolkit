using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// Project-wide debugger breakpoint store, persisted to
    /// <c>Library/Unterm/breakpoints.json</c> (the same convention as the rest of
    /// Unterm's editor state). It is the single source of truth shared by BOTH the
    /// editor and the standalone debugger process — the debugger writes the same file
    /// directly when you toggle a breakpoint while stopped (when the editor is frozen
    /// and can't run), so edits from either side persist.
    ///
    /// Lines are 0-based, matching the native code editor's gutter line indices
    /// (converted to 1-based when handed to the SDB debugger, whose sequence points
    /// are 1-based source lines).
    /// </summary>
    [InitializeOnLoad]
    internal static class UntermBreakpoints
    {
        [System.Serializable]
        private class Entry { public string path; public int[] lines; }
        [System.Serializable]
        private class Store { public Entry[] files; }

        private static Dictionary<string, SortedSet<int>> _map;

        private static string Dir =>
            Path.Combine(Path.GetDirectoryName(Application.dataPath), "Library", "Unterm");
        private static string StorePath => Path.Combine(Dir, "breakpoints.json");

        /// Raised when the store file changes on disk — i.e. the debugger toggled a
        /// breakpoint while we run — so open code editors can refresh their gutter dots.
        public static event System.Action Changed;

        // Last write time we've accounted for; poll for anything newer (the debugger's
        // edits), and stamp it after our own writes so we don't fire on those.
        private static long _seenTicks;

        static UntermBreakpoints()
        {
            _seenTicks = FileTicks();
            EditorApplication.update += Poll;
        }

        private static long FileTicks()
        {
            try { return File.Exists(StorePath) ? File.GetLastWriteTimeUtc(StorePath).Ticks : 0; }
            catch { return 0; }
        }

        private static void Poll()
        {
            long ticks = FileTicks();
            if (ticks == _seenTicks) return;
            _seenTicks = ticks;
            _map = null;          // drop the cache; next read reloads from disk
            Changed?.Invoke();
        }

        private static Dictionary<string, SortedSet<int>> Map
        {
            get { if (_map == null) Load(); return _map; }
        }

        /// Re-read from disk (e.g. to pick up edits the debugger made while stopped).
        public static void Reload() => _map = null;

        /// 0-based breakpoint lines for a file (ascending), as uint[] for the FFI.
        public static uint[] For(string path)
        {
            if (!string.IsNullOrEmpty(path) && Map.TryGetValue(Norm(path), out var s))
            {
                var a = new uint[s.Count];
                int i = 0;
                foreach (var l in s) a[i++] = (uint)l;
                return a;
            }
            return System.Array.Empty<uint>();
        }

        /// Toggle a 0-based breakpoint line; returns the file's new full set.
        public static uint[] Toggle(string path, int line)
        {
            if (string.IsNullOrEmpty(path)) return System.Array.Empty<uint>();
            var key = Norm(path);
            if (!Map.TryGetValue(key, out var s)) { s = new SortedSet<int>(); Map[key] = s; }
            if (!s.Remove(line)) s.Add(line);
            if (s.Count == 0) Map.Remove(key);
            Save();
            return For(path);
        }

        /// All (absolute file path, 0-based line) breakpoints across the project.
        public static List<KeyValuePair<string, int>> All()
        {
            var r = new List<KeyValuePair<string, int>>();
            foreach (var kv in Map)
                foreach (var l in kv.Value)
                    r.Add(new KeyValuePair<string, int>(kv.Key, l));
            return r;
        }

        private static string Norm(string p)
        {
            try { return Path.GetFullPath(p); } catch { return p; }
        }

        private static void Load()
        {
            _map = new Dictionary<string, SortedSet<int>>();
            try
            {
                if (!File.Exists(StorePath)) return;
                var store = JsonUtility.FromJson<Store>(File.ReadAllText(StorePath));
                if (store?.files == null) return;
                foreach (var e in store.files)
                {
                    if (string.IsNullOrEmpty(e.path) || e.lines == null) continue;
                    var set = new SortedSet<int>();
                    foreach (var l in e.lines) set.Add(l);
                    if (set.Count > 0) _map[Norm(e.path)] = set;
                }
            }
            catch { /* corrupt store: start empty */ }
        }

        private static void Save()
        {
            try
            {
                Directory.CreateDirectory(Dir);
                var entries = new List<Entry>(_map.Count);
                foreach (var kv in _map)
                {
                    var arr = new int[kv.Value.Count];
                    kv.Value.CopyTo(arr);
                    entries.Add(new Entry { path = kv.Key, lines = arr });
                }
                File.WriteAllText(StorePath, JsonUtility.ToJson(new Store { files = entries.ToArray() }));
                _seenTicks = FileTicks(); // our own write; don't re-fire Changed for it
            }
            catch { /* best effort */ }
        }
    }
}
