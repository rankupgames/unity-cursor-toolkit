using System;
using System.Linq;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;

namespace Unterm.Editor
{
    /// <summary>
    /// Package Manager tools. list/info read the installed set synchronously
    /// (PackageInfo.GetAllRegisteredPackages); add/remove go through the async
    /// Client API, surfaced as deferred results that UntermMcpServer polls each
    /// editor tick until the request completes.
    /// </summary>
    internal sealed class UntermPackageTools : IUntermToolGroup
    {
        public void Register(UntermToolSink t)
        {
            t.Add(
                "unity_package",
                "Unity Package Manager. action: list (installed packages), info (id = package name), " +
                "add (id = name, name@version, or git url), remove (id = package name).",
                t.Schema(
                    ("action", "string", "list | info | add | remove", new[] { "list", "info", "add", "remove" }),
                    ("id", "string", "Package name/id for info/add/remove", null)),
                args =>
                {
                    string id = (string)args["id"];
                    switch ((string)args["action"])
                    {
                        case "info":
                        {
                            var p = PackageInfo.GetAllRegisteredPackages().FirstOrDefault(x => x.name == id);
                            if (p == null) return new { ok = false, error = "not installed: " + id };
                            return new { p.name, p.displayName, p.version, source = p.source.ToString(), p.description };
                        }
                        case "add":
                        {
                            if (string.IsNullOrEmpty(id)) return new { ok = false, error = "id required" };
                            var req = Client.Add(id);
                            return Deferred(req, () => new { ok = true, added = req.Result.name, version = req.Result.version });
                        }
                        case "remove":
                        {
                            if (string.IsNullOrEmpty(id)) return new { ok = false, error = "id required" };
                            var req = Client.Remove(id);
                            return Deferred(req, () => new { ok = true, removed = id });
                        }
                        default: // list
                        {
                            var all = PackageInfo.GetAllRegisteredPackages()
                                .Select(p => new { p.name, p.version, source = p.source.ToString() })
                                .OrderBy(p => p.name).ToArray();
                            return new { count = all.Length, packages = all };
                        }
                    }
                });
        }

        /// Wrap an async Client request: polled each tick, mapped on completion.
        private static UntermDeferredResult Deferred(Request req, Func<object> onSuccess) =>
            new UntermDeferredResult
            {
                Poll = () =>
                {
                    if (!req.IsCompleted) return null;
                    return req.Status == StatusCode.Success
                        ? onSuccess()
                        : new { ok = false, error = req.Error != null ? req.Error.message : "failed" };
                },
            };
    }
}
