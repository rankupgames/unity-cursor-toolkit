using System;
using System.Collections.Generic;
using System.Threading;
using UnityEditor;

namespace Unterm.Editor
{
    /// <summary>
    /// A single long-lived background thread that runs Roslyn completion off the main
    /// thread (LSP-style), shared by all code-editor windows. Requests are COALESCED:
    /// only the latest pending request is processed, so rapid typing never piles up
    /// analyses. The main thread submits (cheap) and polls <see cref="TryTake"/> for the
    /// result of the sequence number it's waiting on.
    /// </summary>
    internal static class UntermCompletionWorker
    {
        // Mode: 0 = general (scope symbols), 1 = member (after `.`), 2 = attribute (after `[`).
        private struct Request { public long Seq; public string Text; public int Pos; public int Mode; }

        private static readonly object s_inLock = new object();
        private static Request s_pending;
        private static bool s_hasPending;
        private static long s_seq;

        private static readonly object s_outLock = new object();
        private static long s_resultSeq = -1;
        private static List<(string insert, string label, char kind)> s_result;

        private static readonly AutoResetEvent s_signal = new AutoResetEvent(false);
        private static Thread s_thread;
        private static volatile bool s_stop;

        // Stop the worker before the domain reloads: without this the background
        // thread is left to be aborted mid-analysis and the AutoResetEvent leaks its
        // OS handle. Signalled once; re-entrant Submits in the fresh domain get a
        // clean thread because the statics are reset by the reload.
        [InitializeOnLoadMethod]
        private static void RegisterShutdown()
        {
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
        }

        private static void Shutdown()
        {
            s_stop = true;
            s_signal.Set();
            // Only dispose the event once the loop has actually exited — disposing it
            // out from under a blocked WaitOne would throw on the worker thread.
            if (s_thread != null && s_thread.Join(500))
                s_signal.Dispose();
        }

        /// Queue a completion request (overwriting any not-yet-started one) and return
        /// its sequence number. The reference set must already be built on the main
        /// thread (UntermRoslynCompletion.EnsureReferences) before calling this.
        public static long Submit(string text, int pos, int mode)
        {
            EnsureThread();
            long seq;
            lock (s_inLock)
            {
                seq = ++s_seq;
                s_pending = new Request { Seq = seq, Text = text, Pos = pos, Mode = mode };
                s_hasPending = true;
            }
            s_signal.Set();
            return seq;
        }

        /// If the result for exactly <paramref name="seq"/> is ready, hand it back and
        /// clear it. (Older results are overwritten by newer ones and never match.)
        public static bool TryTake(long seq, out List<(string insert, string label, char kind)> result)
        {
            lock (s_outLock)
            {
                if (s_resultSeq == seq)
                {
                    result = s_result;
                    s_result = null;
                    s_resultSeq = -1;
                    return true;
                }
            }
            result = null;
            return false;
        }

        private static void EnsureThread()
        {
            if (s_thread != null && s_thread.IsAlive) return;
            s_thread = new Thread(Loop) { IsBackground = true, Name = "UntermCompletion" };
            s_thread.Start();
        }

        private static void Loop()
        {
            while (true)
            {
                s_signal.WaitOne();
                if (s_stop) return;
                // Drain: always process the LATEST pending request; if newer ones
                // arrive while computing, the slot holds only the newest, so older
                // ones are coalesced away.
                while (true)
                {
                    Request req;
                    lock (s_inLock)
                    {
                        if (!s_hasPending) break;
                        req = s_pending;
                        s_hasPending = false;
                    }
                    List<(string insert, string label, char kind)> r;
                    try
                    {
                        switch (req.Mode)
                        {
                            case 1: r = UntermRoslynCompletion.MemberCompletions(req.Text, req.Pos); break;
                            case 2: r = UntermRoslynCompletion.AttributeCompletions(req.Text, req.Pos); break;
                            case 3: r = UntermRoslynCompletion.TypeCompletions(req.Text, req.Pos); break;
                            case 4: r = UntermRoslynCompletion.NamespaceCompletions(req.Text, req.Pos); break;
                            case 5: r = UntermRoslynCompletion.OverrideCompletions(req.Text, req.Pos); break;
                            default: r = UntermRoslynCompletion.GeneralCompletions(req.Text, req.Pos); break;
                        }
                    }
                    catch (Exception e) { r = null; UntermLog.WarnOnce("completion.worker", e); }
                    lock (s_outLock)
                    {
                        s_resultSeq = req.Seq;
                        s_result = r;
                    }
                }
            }
        }
    }
}
