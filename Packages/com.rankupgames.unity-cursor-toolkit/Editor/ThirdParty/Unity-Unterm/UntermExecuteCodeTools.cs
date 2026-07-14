using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using RoslynCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation;

namespace Unterm.Editor
{
    /// <summary>
    /// Dynamic C# execution via bundled Roslyn (MIT) — the same approach Unity's
    /// own AI Assistant uses: wrap the snippet in a method, compile it in-memory
    /// with CSharpCompilation.Emit, Assembly.Load the bytes, and invoke. No domain
    /// reload, no temp files, and a compile error is isolated to this call.
    ///
    /// WARNING: runs arbitrary code in the editor. The central MCP policy classifies
    /// this tool as dangerous. It requires one-shot Editor approval unless this
    /// project has both Allow Dangerous and the separate full-machine-access opt-in;
    /// unattended requests that do not satisfy both gates are denied.
    /// </summary>
    internal sealed class UntermExecuteCodeTools : IUntermToolGroup
    {
        public void Register(UntermToolSink t)
        {
            t.Add(
                "unity_execute_code",
                "Compile and run a C# snippet in the editor (Roslyn, in-memory; immediate, no reload). " +
                "code = the body of `object Run()` — use `return <value>;` and Debug.Log(...). " +
                "usings for System/Linq/Collections/UnityEngine/UnityEditor are provided.",
                t.Schema(
                    ("code", "string", "C# statements (body of object Run())", null),
                    ("title", "string", "Optional label", null)),
                args =>
                {
                    string code = (string)args["code"];
                    if (string.IsNullOrWhiteSpace(code))
                        return new { ok = false, error = "code required" };

                    string source =
                        "using System;\n" +
                        "using System.Linq;\n" +
                        "using System.Collections;\n" +
                        "using System.Collections.Generic;\n" +
                        "using UnityEngine;\n" +
                        "using UnityEditor;\n" +
                        "public static class __UntermRun {\n" +
                        "    public static object Run() {\n" +
                        code + "\n" +
                        "        return null;\n" +
                        "    }\n" +
                        "}\n";

                    var tree = CSharpSyntaxTree.ParseText(source);
                    var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary);
                    var compilation = RoslynCompilation.Create(
                        "UntermDynamic_" + Guid.NewGuid().ToString("N"),
                        new[] { tree }, BuildReferences(), options);

                    using var ms = new MemoryStream();
                    var emit = compilation.Emit(ms);
                    if (!emit.Success)
                    {
                        var diags = emit.Diagnostics
                            .Where(d => d.Severity == DiagnosticSeverity.Error)
                            .Select(d => d.ToString()).Take(20).ToArray();
                        return new { ok = false, error = "compilation failed", diagnostics = diags };
                    }

                    var asm = System.Reflection.Assembly.Load(ms.ToArray());
                    var method = asm.GetType("__UntermRun")?.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
                    if (method == null)
                        return new { ok = false, error = "Run method not found" };

                    var logs = new List<string>();
                    Application.LogCallback capture = (c, s, lt) => logs.Add($"[{lt}] {c}");
                    Application.logMessageReceived += capture;
                    try
                    {
                        var result = method.Invoke(null, null);
                        return new { ok = true, result = result?.ToString(), logs };
                    }
                    catch (TargetInvocationException tie)
                    {
                        return new { ok = false, error = "runtime error: " + (tie.InnerException ?? tie).Message, logs };
                    }
                    finally
                    {
                        Application.logMessageReceived -= capture;
                    }
                });
        }

        /// References: core BCL + UnityEngine/UnityEditor + all project assemblies.
        private static List<MetadataReference> BuildReferences()
        {
            var refs = new List<MetadataReference>();
            void AddType(Type ty)
            {
                try { refs.Add(MetadataReference.CreateFromFile(ty.Assembly.Location)); } catch (Exception e) { UntermLog.WarnOnce("executeCode.addType", e); }
            }
            AddType(typeof(object));
            AddType(typeof(Enumerable));
            AddType(typeof(List<>));
            AddType(typeof(System.Collections.IEnumerable));
            AddType(typeof(System.Linq.Expressions.Expression));
            AddType(typeof(UnityEngine.Debug));
            AddType(typeof(UnityEditor.Editor));

            try
            {
                var ns = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "netstandard");
                if (ns != null && !string.IsNullOrEmpty(ns.Location))
                    refs.Add(MetadataReference.CreateFromFile(ns.Location));
            }
            catch (Exception e) { UntermLog.WarnOnce("executeCode.netstandardRef", e); }

            foreach (var a in CompilationPipeline.GetAssemblies(AssembliesType.Editor))
            {
                try
                {
                    var p = Path.GetFullPath(a.outputPath);
                    if (File.Exists(p)) refs.Add(MetadataReference.CreateFromFile(p));
                }
                catch (Exception e) { UntermLog.WarnOnce("executeCode.projectRef", e); }
            }

            return refs.GroupBy(r => r.Display).Select(g => g.First()).ToList();
        }
    }
}
