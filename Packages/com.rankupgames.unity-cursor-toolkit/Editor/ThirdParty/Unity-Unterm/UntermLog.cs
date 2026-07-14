using System;
using System.Collections.Generic;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// Diagnostics for best-effort paths (Roslyn completion augmentations, reference
    /// gathering, background workers) that previously swallowed exceptions silently.
    /// <see cref="WarnOnce"/> deduplicates by call site + exception, so a failure that
    /// recurs every keystroke is reported once instead of flooding the Console — the
    /// error stays diagnosable without turning the log into noise. Safe to call off the
    /// main thread: Unity marshals <see cref="Debug.LogWarning(object)"/> internally.
    /// </summary>
    internal static class UntermLog
    {
        private static readonly HashSet<string> s_seen = new HashSet<string>();

        public static void WarnOnce(string context, Exception e)
        {
            if (e == null) return;
            string key = context + "|" + e.GetType().Name + "|" + e.Message;
            lock (s_seen)
            {
                if (!s_seen.Add(key)) return;
            }
            Debug.LogWarning($"[Unterm] {context}: {e.GetType().Name}: {e.Message}");
        }
    }
}
