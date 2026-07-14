using System;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>One session in the picker: id + derived title + last-modified.</summary>
    internal struct UntermSessionInfo
    {
        public string id;
        public string title;
        public ulong updated; // file mtime, unix seconds
        public string snippet; // match context (search only)
    }

    /// <summary>Parse the native `[{id,title,updated,snippet}]` listing result.</summary>
    internal static class UntermSessionJson
    {
        public static UntermSessionInfo[] Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return Array.Empty<UntermSessionInfo>();
            try
            {
                var arr = JArray.Parse(json);
                var list = new UntermSessionInfo[arr.Count];
                for (int i = 0; i < arr.Count; i++)
                {
                    var o = arr[i];
                    list[i] = new UntermSessionInfo
                    {
                        id = (string)o["id"] ?? "",
                        title = (string)o["title"] ?? "",
                        updated = (ulong?)o["updated"] ?? 0,
                        snippet = (string)o["snippet"] ?? "",
                    };
                }
                return list;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Unterm] session list parse failed: " + e.Message);
                return Array.Empty<UntermSessionInfo>();
            }
        }
    }
}
