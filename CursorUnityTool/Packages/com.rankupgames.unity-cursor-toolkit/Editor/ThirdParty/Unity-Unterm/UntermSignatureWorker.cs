using System;
using System.Threading;
using UnityEditor;

namespace Unterm.Editor
{
    /// <summary>
    /// Background thread that computes Roslyn signature help (parameter hints) off the
    /// typing path, coalescing requests like <see cref="UntermCompletionWorker"/>: only
    /// the latest pending request is processed. The main thread submits cheaply and
    /// polls <see cref="TryTake"/> for the sequence it's waiting on.
    /// </summary>
    internal static class UntermSignatureWorker
    {
        private struct Request { public long Seq; public string Text; public int Pos; }

        private static readonly object s_inLock = new object();
        private static Request s_pending;
        private static bool s_hasPending;
        private static long s_seq;

        private static readonly object s_outLock = new object();
        private static long s_resultSeq = -1;
        private static UntermRoslynCompletion.SigHelp s_result;

        private static readonly AutoResetEvent s_signal = new AutoResetEvent(false);
        private static Thread s_thread;
        private static volatile bool s_stop;

        // Stop the worker before the domain reloads so its thread isn't aborted
        // mid-analysis and the AutoResetEvent doesn't leak its OS handle. See the
        // matching note in UntermCompletionWorker.
        [InitializeOnLoadMethod]
        private static void RegisterShutdown()
        {
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
        }

        private static void Shutdown()
        {
            s_stop = true;
            s_signal.Set();
            if (s_thread != null && s_thread.Join(500))
                s_signal.Dispose();
        }

        public static long Submit(string text, int pos)
        {
            EnsureThread();
            long seq;
            lock (s_inLock)
            {
                seq = ++s_seq;
                s_pending = new Request { Seq = seq, Text = text, Pos = pos };
                s_hasPending = true;
            }
            s_signal.Set();
            return seq;
        }

        public static bool TryTake(long seq, out UntermRoslynCompletion.SigHelp result)
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
            s_thread = new Thread(Loop) { IsBackground = true, Name = "UntermSignature" };
            s_thread.Start();
        }

        private static void Loop()
        {
            while (true)
            {
                s_signal.WaitOne();
                if (s_stop) return;
                while (true)
                {
                    Request req;
                    lock (s_inLock)
                    {
                        if (!s_hasPending) break;
                        req = s_pending;
                        s_hasPending = false;
                    }
                    UntermRoslynCompletion.SigHelp r;
                    try { r = UntermRoslynCompletion.SignatureHelp(req.Text, req.Pos); }
                    catch (Exception e) { r = null; UntermLog.WarnOnce("signature.worker", e); }
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
