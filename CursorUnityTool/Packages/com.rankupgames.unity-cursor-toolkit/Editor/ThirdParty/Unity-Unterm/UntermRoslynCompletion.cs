using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using UnityEditor.Compilation;

namespace Unterm.Editor
{
    /// <summary>
    /// Semantic (Roslyn) completion for C#. Uses Unity's bundled Microsoft.CodeAnalysis
    /// core (referenced by the asmdef) to build a <see cref="CSharpCompilation"/> from the
    /// project's assemblies and resolve member completions via the <see cref="SemanticModel"/>.
    /// The Roslyn Features package (with CompletionService) isn't shipped by Unity, so
    /// member lists are enumerated from type symbols directly.
    ///
    /// Stage 2 covers member access (`expr.`); other contexts fall back to the Stage 1
    /// keyword + buffer-identifier completion in the window.
    /// </summary>
    internal static class UntermRoslynCompletion
    {
        // Project-wide metadata references, cached (reused so Roslyn caches the parsed
        // assembly metadata across completion requests). Invalidate on a recompile.
        private static List<MetadataReference> s_refs;

        // Index of public type simple-name → namespaces that declare it, across all
        // referenced assemblies. Built once (lazily) for unimported-type completion +
        // auto-using; rebuilt when references change.
        private static Dictionary<string, List<string>> s_typeIndex;

        public static void InvalidateReferences() { s_refs = null; s_typeIndex = null; }

        /// Build the reference set on the MAIN thread (CompilationPipeline is a Unity
        /// API and must not be touched off-main). Call this before kicking a background
        /// completion task; the task then only reads the cached references.
        public static void EnsureReferences() => References();

        /// Build the reference set AND force-load the common Unity assemblies' metadata
        /// up front (off the typing path), so the first member completion doesn't pay
        /// the metadata cost mid-keystroke.
        public static void Warmup()
        {
            try
            {
                var comp = CSharpCompilation.Create(
                    "__warm", Array.Empty<SyntaxTree>(), References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                comp.GetTypeByMetadataName("UnityEngine.GameObject");
                comp.GetTypeByMetadataName("UnityEngine.Transform");
                comp.GetTypeByMetadataName("UnityEngine.Time");
            }
            catch { /* best effort */ }
        }

        private static List<MetadataReference> References()
        {
            if (s_refs != null) return s_refs;
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var asm in CompilationPipeline.GetAssemblies())
                {
                    if (asm.compiledAssemblyReferences != null)
                        foreach (var r in asm.compiledAssemblyReferences) paths.Add(r);
                    if (asm.allReferences != null)
                        foreach (var r in asm.allReferences) paths.Add(r);
                    // The assembly's own compiled output, so the user's types across other
                    // files resolve too (when it has been compiled at least once).
                    if (!string.IsNullOrEmpty(asm.outputPath)) paths.Add(asm.outputPath);
                }
            }
            catch { /* fall through with whatever we gathered */ }

            var refs = new List<MetadataReference>();
            foreach (var p in paths)
            {
                try { if (File.Exists(p)) refs.Add(MetadataReference.CreateFromFile(p)); }
                catch { /* skip unreadable */ }
            }
            s_refs = refs;
            return s_refs;
        }

        /// <summary>
        /// All members of the expression before the caret (UNFILTERED — the caller
        /// caches this once per member-access and filters by the typed prefix itself,
        /// so Roslyn isn't re-run on every keystroke). Returns null when the context is
        /// NOT a member access; an empty list means "member access, nothing resolved".
        /// Each item is the bare member name to INSERT plus a display label.
        /// </summary>
        public static List<(string insert, string label, char kind)> MemberCompletions(string text, int position)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var root = tree.GetRoot();
                var token = root.FindToken(Math.Max(0, position - 1));

                // Walk up to an enclosing member-access expression (`a.b`).
                MemberAccessExpressionSyntax ma = null;
                for (var node = token.Parent; node != null; node = node.Parent)
                {
                    if (node is MemberAccessExpressionSyntax m) { ma = m; break; }
                    // Stop if we leave the statement (avoid matching an unrelated outer `.`).
                    if (node is StatementSyntax || node is MemberDeclarationSyntax) break;
                }
                if (ma == null) return null;

                var comp = CSharpCompilation.Create(
                    "UntermCompletion",
                    new[] { tree },
                    References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);

                // Decide static vs instance FIRST by what the expression binds to:
                // if it resolves to a TYPE (e.g. `Time`), it's static access; otherwise
                // it's a value and we use its type. (GetTypeInfo().Type is non-null even
                // for a type name, so it can't distinguish the two.)
                ITypeSymbol type;
                bool isStatic;
                if (model.GetSymbolInfo(ma.Expression).Symbol is ITypeSymbol ts)
                {
                    type = ts;
                    isStatic = true;
                }
                else
                {
                    type = model.GetTypeInfo(ma.Expression).Type;
                    isStatic = false;
                }
                if (type == null) return new List<(string, string, char)>();

                // Collect public members, dedup by name (first declaration wins), and
                // count method overloads so the label can note them.
                var best = new Dictionary<string, ISymbol>(StringComparer.Ordinal);
                var overloads = new Dictionary<string, int>(StringComparer.Ordinal);
                for (var t = type; t != null; t = t.BaseType)
                {
                    foreach (var m in t.GetMembers())
                    {
                        if (m.DeclaredAccessibility != Accessibility.Public) continue;
                        // Static access shows static members + nested types; instance
                        // access shows instance members.
                        if (isStatic ? (!m.IsStatic && m.Kind != SymbolKind.NamedType) : m.IsStatic) continue;
                        if (m.Kind == SymbolKind.Method
                            && ((IMethodSymbol)m).MethodKind != MethodKind.Ordinary)
                            continue; // skip get_/set_/ctor/operator
                        var name = m.Name;
                        if (string.IsNullOrEmpty(name) || name[0] == '<' || name[0] == '.') continue;
                        if (m.Kind == SymbolKind.Method)
                            overloads[name] = overloads.TryGetValue(name, out var c) ? c + 1 : 1;
                        if (!best.ContainsKey(name)) best[name] = m;
                    }
                }

                var result = new List<(string, string, char)>();
                foreach (var name in best.Keys.OrderBy(k => k, StringComparer.Ordinal))
                    result.Add((name, Label(best[name], overloads.TryGetValue(name, out var c) ? c : 0), Kind(best[name])));
                return result;
            }
            catch
            {
                return null;
            }
        }

        /// All symbols in scope at the caret (types, namespaces, locals, parameters,
        /// members of the enclosing type, etc.) for non-member completion — so class
        /// names and the like complete, not just buffer words. UNFILTERED (the caller
        /// caches + filters by prefix). Returns null on failure.
        public static List<(string insert, string label, char kind)> GeneralCompletions(string text, int position)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var comp = CSharpCompilation.Create(
                    "UntermCompletion", new[] { tree }, References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);
                var root = tree.GetRoot();

                var best = new Dictionary<string, ISymbol>(StringComparer.Ordinal);
                var overloads = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var s in model.LookupSymbols(position))
                {
                    switch (s.Kind)
                    {
                        case SymbolKind.Namespace:
                        case SymbolKind.NamedType:
                        case SymbolKind.Method:
                        case SymbolKind.Property:
                        case SymbolKind.Field:
                        case SymbolKind.Local:
                        case SymbolKind.Parameter:
                        case SymbolKind.Event:
                            break;
                        default: continue;
                    }
                    var name = s.Name;
                    if (string.IsNullOrEmpty(name) || name[0] == '<' || name[0] == '.') continue;
                    if (s.Kind == SymbolKind.Method)
                    {
                        var mk = ((IMethodSymbol)s).MethodKind;
                        if (mk != MethodKind.Ordinary && mk != MethodKind.LocalFunction) continue;
                        overloads[name] = overloads.TryGetValue(name, out var c) ? c + 1 : 1;
                    }
                    if (!best.ContainsKey(name)) best[name] = s;
                }

                var result = new List<(string, string, char)>();
                foreach (var name in best.Keys.OrderBy(k => k, StringComparer.Ordinal))
                    result.Add((name, Label(best[name], overloads.TryGetValue(name, out var c) ? c : 0), Kind(best[name])));

                // Context augmentations (best-effort; never fail the whole completion):
                // members the position specifically expects, surfaced before scope.
                try { AddExpectedEnum(result, root, model, position); } catch (Exception e) { UntermLog.WarnOnce("completion.expectedEnum", e); }
                try { AddNamedArguments(result, root, model, position); } catch (Exception e) { UntermLog.WarnOnce("completion.namedArguments", e); }
                try { AddObjectInitializerMembers(result, root, model, position); } catch (Exception e) { UntermLog.WarnOnce("completion.objectInitializer", e); }
                // Build the cross-assembly type index once (off the typing path); the
                // host queries it per keystroke via UnimportedTypesMatching — those
                // are prefix-dependent, so they can't ride the per-word symbol cache.
                try { EnsureTypeIndex(comp); } catch (Exception e) { UntermLog.WarnOnce("completion.typeIndex", e); }
                return result;
            }
            catch (Exception e)
            {
                UntermLog.WarnOnce("completion.general", e);
                return null;
            }
        }

        // If the caret is inside a call's argument list, surface the target method's
        // parameter names as `name:` items (so a named argument can be completed),
        // skipping names already supplied. Inserted at the front so they rank first.
        private static void AddNamedArguments(
            List<(string insert, string label, char kind)> result, SyntaxNode root, SemanticModel model, int position)
        {
            var token = root.FindToken(Math.Max(0, position - 1));
            var argList = token.Parent?.FirstAncestorOrSelf<ArgumentListSyntax>();
            if (argList == null) return;
            SymbolInfo info;
            switch (argList.Parent)
            {
                case InvocationExpressionSyntax inv: info = model.GetSymbolInfo(inv); break;
                case ObjectCreationExpressionSyntax oc: info = model.GetSymbolInfo(oc); break;
                default: return;
            }
            var methods = new List<IMethodSymbol>();
            if (info.Symbol is IMethodSymbol ms) methods.Add(ms);
            foreach (var cand in info.CandidateSymbols) if (cand is IMethodSymbol cm) methods.Add(cm);
            if (methods.Count == 0) return;
            var used = new HashSet<string>(argList.Arguments
                .Where(a => a.NameColon != null)
                .Select(a => a.NameColon.Name.Identifier.ValueText));
            var added = new HashSet<string>(StringComparer.Ordinal);
            int at = 0;
            foreach (var meth in methods)
                foreach (var p in meth.Parameters)
                {
                    var n = p.Name;
                    if (string.IsNullOrEmpty(n) || used.Contains(n) || !added.Add(n)) continue;
                    result.Insert(at++, (n + ": ", n + ":", 'A')); // `name:` named-argument item
                }
        }

        // If the caret's position expects an enum-typed value (assignment, ==/!=, a
        // typed local initializer, or a switch `case`), surface that enum's members
        // fully qualified (`Enum.Member`, valid in any of those spots) before scope.
        private static void AddExpectedEnum(
            List<(string insert, string label, char kind)> result, SyntaxNode root, SemanticModel model, int position)
        {
            var token = root.FindToken(Math.Max(0, position - 1));
            var expected = InferExpectedType(token, model);
            if (!(expected is INamedTypeSymbol e) || e.TypeKind != TypeKind.Enum) return;
            int at = 0;
            foreach (var m in e.GetMembers())
                if (m is IFieldSymbol f && f.IsConst)
                {
                    string q = e.Name + "." + f.Name;
                    result.Insert(at++, (q, q, 'E'));
                }
        }

        // If the caret is inside an object initializer (`new Foo { <caret> }`), surface
        // the created type's settable public properties/fields as `Name = ` items,
        // skipping ones already assigned. Inherited members are included.
        private static void AddObjectInitializerMembers(
            List<(string insert, string label, char kind)> result, SyntaxNode root, SemanticModel model, int position)
        {
            var token = root.FindToken(Math.Max(0, position - 1));
            var init = token.Parent?.FirstAncestorOrSelf<InitializerExpressionSyntax>();
            if (init == null || !init.IsKind(SyntaxKind.ObjectInitializerExpression)) return;
            if (!(init.Parent is ObjectCreationExpressionSyntax oc)) return;
            var type = model.GetTypeInfo(oc).Type;
            if (type == null) return;
            var used = new HashSet<string>(init.Expressions
                .OfType<AssignmentExpressionSyntax>()
                .Select(a => (a.Left as IdentifierNameSyntax)?.Identifier.ValueText)
                .Where(s => !string.IsNullOrEmpty(s)));
            var added = new HashSet<string>(StringComparer.Ordinal);
            int at = 0;
            for (var t = type; t != null; t = t.BaseType)
                foreach (var m in t.GetMembers())
                {
                    if (m.DeclaredAccessibility != Accessibility.Public || used.Contains(m.Name) || !added.Add(m.Name))
                        continue;
                    if (m is IPropertySymbol p && !p.IsReadOnly && p.SetMethod != null)
                        result.Insert(at++, (p.Name + " = ", p.Name, 'P'));
                    else if (m is IFieldSymbol f && !f.IsReadOnly && !f.IsConst && !f.IsImplicitlyDeclared)
                        result.Insert(at++, (f.Name + " = ", f.Name, 'F'));
                }
        }

        // Best-effort "expected type" at `token`: the LHS of an assignment, the typed
        // local being initialized, the other side of an ==/!=, or a switch's governing
        // type for a `case`. Null if none applies. Stops at the enclosing statement.
        private static ITypeSymbol InferExpectedType(SyntaxToken token, SemanticModel model)
        {
            for (var node = token.Parent; node != null; node = node.Parent)
            {
                switch (node)
                {
                    case AssignmentExpressionSyntax asn:
                        return model.GetTypeInfo(asn.Left).Type;
                    case EqualsValueClauseSyntax ev when ev.Parent is VariableDeclaratorSyntax vd
                            && vd.Parent is VariableDeclarationSyntax vdecl && !vdecl.Type.IsVar:
                        return model.GetTypeInfo(vdecl.Type).Type;
                    case BinaryExpressionSyntax bin
                            when bin.IsKind(SyntaxKind.EqualsExpression) || bin.IsKind(SyntaxKind.NotEqualsExpression):
                        var other = bin.Left.Span.Contains(token.Span) ? bin.Right : bin.Left;
                        return model.GetTypeInfo(other).Type;
                    case CaseSwitchLabelSyntax csl when csl.Parent?.Parent is SwitchStatementSyntax sw:
                        return model.GetTypeInfo(sw.Expression).Type;
                }
                if (node is StatementSyntax || node is MemberDeclarationSyntax) break;
            }
            return null;
        }

        // Attribute completions for a caret right after `[`: named types in scope
        // that derive from System.Attribute (concrete only), with the conventional
        // "Attribute" suffix trimmed since C# lets you omit it, plus namespaces so a
        // type can be qualified. UNFILTERED (the caller filters by the typed prefix).
        public static List<(string insert, string label, char kind)> AttributeCompletions(string text, int position)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var comp = CSharpCompilation.Create(
                    "UntermCompletion", new[] { tree }, References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);

                var seen = new HashSet<string>(StringComparer.Ordinal);
                var result = new List<(string, string, char)>();
                foreach (var s in model.LookupSymbols(position))
                {
                    if (s is INamespaceSymbol ns)
                    {
                        if (!string.IsNullOrEmpty(ns.Name) && seen.Add("N:" + ns.Name))
                            result.Add((ns.Name, ns.Name, 'N'));
                        continue;
                    }
                    if (s is INamedTypeSymbol t && !t.IsAbstract && IsAttributeType(t))
                    {
                        string name = t.Name;
                        if (string.IsNullOrEmpty(name) || name[0] == '<') continue;
                        string insert = name.Length > 9 && name.EndsWith("Attribute", StringComparison.Ordinal)
                            ? name.Substring(0, name.Length - "Attribute".Length)
                            : name;
                        if (seen.Add("T:" + insert)) result.Add((insert, insert, 'T'));
                    }
                }
                return result;
            }
            catch
            {
                return null;
            }
        }

        // Types NOT in scope whose name starts with `prefix` (≥3 chars), each carrying
        // its namespace in the label (`Name  (Namespace)`) and kind 'U'; the host
        // inserts the `using` on accept. Reads the prebuilt index, so it's cheap enough
        // to call per keystroke from the main thread (no Roslyn parse). Null if the
        // index isn't built yet.
        public static List<(string insert, string label, char kind)> UnimportedTypesMatching(
            string prefix, ICollection<string> inScopeNames)
        {
            var idx = s_typeIndex;
            if (idx == null || string.IsNullOrEmpty(prefix) || prefix.Length < 3) return null;
            var inScope = inScopeNames as HashSet<string>
                ?? new HashSet<string>(inScopeNames ?? Array.Empty<string>(), StringComparer.Ordinal);
            var result = new List<(string, string, char)>();
            int count = 0;
            foreach (var kv in idx)
            {
                if (count >= 40) break;
                if (inScope.Contains(kv.Key)) continue; // already importable in this file
                if (!kv.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var ns in kv.Value)
                {
                    result.Add((kv.Key, kv.Key + "  (" + ns + ")", 'U'));
                    if (++count >= 40) break;
                }
            }
            return result;
        }

        // The namespace encoded in an unimported-type label (`Name  (Namespace)`), or
        // null. Used by the host to insert the matching `using` when one is accepted.
        public static string NamespaceFromUnimportedLabel(string label)
        {
            if (string.IsNullOrEmpty(label)) return null;
            int o = label.LastIndexOf('('), c = label.LastIndexOf(')');
            return (o >= 0 && c > o) ? label.Substring(o + 1, c - o - 1) : null;
        }

        private static void EnsureTypeIndex(CSharpCompilation comp)
        {
            if (s_typeIndex != null) return;
            var idx = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            void Walk(INamespaceSymbol ns)
            {
                string nsName = ns.IsGlobalNamespace ? "" : ns.ToDisplayString();
                if (!string.IsNullOrEmpty(nsName))
                    foreach (var t in ns.GetTypeMembers())
                    {
                        if (t.DeclaredAccessibility != Accessibility.Public) continue;
                        if (string.IsNullOrEmpty(t.Name) || t.Name[0] == '<') continue;
                        if (!idx.TryGetValue(t.Name, out var list)) { list = new List<string>(); idx[t.Name] = list; }
                        if (!list.Contains(nsName)) list.Add(nsName);
                    }
                foreach (var child in ns.GetNamespaceMembers()) Walk(child);
            }
            try { Walk(comp.GlobalNamespace); } catch (Exception e) { UntermLog.WarnOnce("completion.typeIndexWalk", e); }
            s_typeIndex = idx;
        }

        // Whether `t` derives (transitively) from System.Attribute.
        private static bool IsAttributeType(INamedTypeSymbol t)
        {
            for (var b = t.BaseType; b != null; b = b.BaseType)
                if (b.Name == "Attribute" && b.ContainingNamespace?.ToDisplayString() == "System")
                    return true;
            return false;
        }

        // Scope symbols at the caret, kept by `keep` and projected to insert/label/kind.
        // The shared core for context-filtered completions. UNFILTERED by prefix.
        private static List<(string insert, string label, char kind)> ScopeFiltered(
            string text, int position, Func<ISymbol, bool> keep)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var comp = CSharpCompilation.Create(
                    "UntermCompletion", new[] { tree }, References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var result = new List<(string, string, char)>();
                foreach (var s in model.LookupSymbols(position))
                {
                    if (!keep(s)) continue;
                    var name = s.Name;
                    if (string.IsNullOrEmpty(name) || name[0] == '<' || name[0] == '.') continue;
                    if (seen.Add(name)) result.Add((name, name, Kind(s)));
                }
                return result;
            }
            catch
            {
                return null;
            }
        }

        // Overridable members of the base type(s) (for a caret after `override `):
        // virtual/abstract/override methods and properties not already declared in the
        // current type, each as a ready-to-paste signature (with a base call or a
        // NotImplementedException for abstract members).
        public static List<(string insert, string label, char kind)> OverrideCompletions(string text, int position)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var comp = CSharpCompilation.Create(
                    "UntermCompletion", new[] { tree }, References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);
                var token = tree.GetRoot().FindToken(Math.Max(0, position - 1));
                var typeDecl = token.Parent?.FirstAncestorOrSelf<TypeDeclarationSyntax>();
                if (typeDecl == null) return null;
                if (!(model.GetDeclaredSymbol(typeDecl) is INamedTypeSymbol self)) return null;

                var existing = new HashSet<string>(self.GetMembers().Select(m => m.Name));
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var result = new List<(string, string, char)>();
                for (var b = self.BaseType; b != null; b = b.BaseType)
                    foreach (var m in b.GetMembers())
                    {
                        if (m.IsSealed || m.IsStatic || m.DeclaredAccessibility == Accessibility.Private) continue;
                        if (!(m.IsVirtual || m.IsAbstract || m.IsOverride)) continue;
                        if (m is IMethodSymbol mm && mm.MethodKind != MethodKind.Ordinary) continue;
                        if (!(m is IMethodSymbol || m is IPropertySymbol)) continue;
                        if (existing.Contains(m.Name) || !seen.Add(m.Name)) continue;
                        var (insert, label) = FormatOverride(m);
                        if (insert != null) result.Add((insert, label, Kind(m)));
                    }
                return result;
            }
            catch
            {
                return null;
            }
        }

        private static readonly SymbolDisplayFormat s_minFmt = SymbolDisplayFormat.MinimallyQualifiedFormat;

        // A pasteable `override` declaration for `m` and a short label (its signature).
        private static (string insert, string label) FormatOverride(ISymbol m)
        {
            string acc = m.DeclaredAccessibility == Accessibility.Protected ? "protected"
                : m.DeclaredAccessibility == Accessibility.ProtectedOrInternal ? "protected internal"
                : "public";
            if (m is IMethodSymbol meth)
            {
                string ret = meth.ReturnType.ToDisplayString(s_minFmt);
                string pars = string.Join(", ", meth.Parameters.Select(p =>
                    (p.RefKind == RefKind.Ref ? "ref " : p.RefKind == RefKind.Out ? "out " : p.RefKind == RefKind.In ? "in " : "")
                    + p.Type.ToDisplayString(s_minFmt) + " " + p.Name));
                string args = string.Join(", ", meth.Parameters.Select(p =>
                    (p.RefKind == RefKind.Ref ? "ref " : p.RefKind == RefKind.Out ? "out " : "") + p.Name));
                string body = meth.IsAbstract
                    ? "throw new System.NotImplementedException();"
                    : (meth.ReturnsVoid ? $"base.{meth.Name}({args});" : $"return base.{meth.Name}({args});");
                string sig = $"{ret} {meth.Name}({pars})";
                return ($"{acc} override {sig}\n{{\n    {body}\n}}", sig);
            }
            if (m is IPropertySymbol prop)
            {
                string type = prop.Type.ToDisplayString(s_minFmt);
                string body;
                if (prop.GetMethod != null && prop.SetMethod != null)
                    body = prop.IsAbstract
                        ? "{ get => throw new System.NotImplementedException(); set => throw new System.NotImplementedException(); }"
                        : $"{{ get => base.{prop.Name}; set => base.{prop.Name} = value; }}";
                else if (prop.GetMethod != null)
                    body = prop.IsAbstract ? "=> throw new System.NotImplementedException();" : $"=> base.{prop.Name};";
                else
                    body = prop.IsAbstract ? "{ set => throw new System.NotImplementedException(); }" : $"{{ set => base.{prop.Name} = value; }}";
                return ($"{acc} override {type} {prop.Name} {body}", $"{type} {prop.Name}");
            }
            return (null, null);
        }

        // Types + namespaces in scope (for `new`): no members, locals, or keywords.
        public static List<(string insert, string label, char kind)> TypeCompletions(string text, int position) =>
            ScopeFiltered(text, position, s => s.Kind == SymbolKind.NamedType || s.Kind == SymbolKind.Namespace);

        // Namespaces in scope (for a `using` directive).
        public static List<(string insert, string label, char kind)> NamespaceCompletions(string text, int position) =>
            ScopeFiltered(text, position, s => s.Kind == SymbolKind.Namespace);

        // One-character kind tag for coloring the popup like the editor: M=method,
        // X=constructor, P=property, V=event, F=field, C=const, L=local, A=parameter,
        // T=type, E=enum, N=namespace, ' '=other.
        private static char Kind(ISymbol m)
        {
            switch (m.Kind)
            {
                case SymbolKind.Method:
                    return ((IMethodSymbol)m).MethodKind == MethodKind.Constructor ? 'X' : 'M';
                case SymbolKind.Property: return 'P';
                case SymbolKind.Event: return 'V';
                case SymbolKind.Field: return ((IFieldSymbol)m).IsConst ? 'C' : 'F';
                case SymbolKind.Local: return 'L';
                case SymbolKind.Parameter: return 'A';
                case SymbolKind.NamedType:
                    return ((INamedTypeSymbol)m).TypeKind == TypeKind.Enum ? 'E' : 'T';
                case SymbolKind.Namespace: return 'N';
                default: return ' ';
            }
        }

        // A display label that shows the symbol's type / signature (insert text is the
        // bare name): `timeScale : float`, `Translate(Vector3, Space) : void (+1)`,
        // `GameObject : class`.
        private static string Label(ISymbol m, int overloadCount)
        {
            string Short(ITypeSymbol t) =>
                t == null ? "" : t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            switch (m)
            {
                case IPropertySymbol p: return $"{p.Name} : {Short(p.Type)}";
                case IFieldSymbol f: return $"{f.Name} : {Short(f.Type)}";
                case IEventSymbol e: return $"{e.Name} : {Short(e.Type)}";
                case ILocalSymbol l: return $"{l.Name} : {Short(l.Type)}";
                case IParameterSymbol pa: return $"{pa.Name} : {Short(pa.Type)}";
                case INamespaceSymbol ns: return $"{ns.Name} : namespace";
                case INamedTypeSymbol nt: return $"{nt.Name} : {nt.TypeKind.ToString().ToLowerInvariant()}";
                case IMethodSymbol me:
                    string extra = overloadCount > 1 ? $" (+{overloadCount - 1})" : "";
                    string ps = string.Join(", ", me.Parameters.Select(pp => Short(pp.Type)));
                    return $"{me.Name}({ps}){extra} : {Short(me.ReturnType)}";
                default: return m.Name;
            }
        }

        // --- signature help (parameter hints) ----------------------------------

        public sealed class SigItem
        {
            public string Prefix;                                  // "Translate("
            public List<string> Parameters = new List<string>();   // ["Vector3 translation", "Space relativeTo"]
            public string Suffix;                                  // ") : void"
        }

        public sealed class SigHelp
        {
            public List<SigItem> Items = new List<SigItem>();      // overloads
            public int ActiveSignature;
            public int ActiveParameter;
        }

        /// Signature help for the call surrounding the caret: finds the enclosing
        /// invocation/object-creation argument list, resolves its overloads, and marks
        /// the active parameter (by commas before the caret). Returns null when the
        /// caret isn't inside a call's parentheses.
        public static SigHelp SignatureHelp(string text, int position)
        {
            if (string.IsNullOrEmpty(text)) return null;
            position = Math.Max(0, Math.Min(position, text.Length));
            try
            {
                var tree = CSharpSyntaxTree.ParseText(text);
                var root = tree.GetRoot();
                var token = root.FindToken(position);
                ArgumentListSyntax argList = null;
                InvocationExpressionSyntax inv = null;
                ObjectCreationExpressionSyntax oc = null;
                for (var nd = token.Parent; nd != null; nd = nd.Parent)
                {
                    if (nd is InvocationExpressionSyntax i && i.ArgumentList != null
                        && position > i.ArgumentList.SpanStart && position <= i.ArgumentList.Span.End)
                    { inv = i; argList = i.ArgumentList; break; }
                    if (nd is ObjectCreationExpressionSyntax o && o.ArgumentList != null
                        && position > o.ArgumentList.SpanStart && position <= o.ArgumentList.Span.End)
                    { oc = o; argList = o.ArgumentList; break; }
                }
                if (argList == null) return null;

                int active = 0;
                foreach (var sep in argList.Arguments.GetSeparators())
                    if (sep.SpanStart < position) active++;

                var comp = CSharpCompilation.Create(
                    "__sig", new[] { tree }, References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var model = comp.GetSemanticModel(tree);

                IEnumerable<IMethodSymbol> methods;
                if (inv != null)
                {
                    methods = model.GetMemberGroup(inv.Expression).OfType<IMethodSymbol>();
                    if (!methods.Any() && model.GetSymbolInfo(inv).Symbol is IMethodSymbol only)
                        methods = new[] { only };
                }
                else
                {
                    var t = model.GetTypeInfo(oc.Type).Type ?? model.GetSymbolInfo(oc.Type).Symbol as ITypeSymbol;
                    methods = t?.GetMembers(".ctor").OfType<IMethodSymbol>()
                                .Where(c => c.DeclaredAccessibility == Accessibility.Public)
                              ?? Enumerable.Empty<IMethodSymbol>();
                }

                string Short(ITypeSymbol ty) =>
                    ty == null ? "" : ty.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
                var help = new SigHelp { ActiveParameter = active };
                foreach (var m in methods.Where(x => x != null).Distinct().OrderBy(x => x.Parameters.Length))
                {
                    var it = new SigItem
                    {
                        Prefix = (m.MethodKind == MethodKind.Constructor
                                    ? (m.ContainingType?.Name ?? m.Name) : m.Name) + "(",
                        Suffix = ")" + (m.MethodKind == MethodKind.Constructor ? "" : " : " + Short(m.ReturnType)),
                    };
                    foreach (var p in m.Parameters) it.Parameters.Add((Short(p.Type) + " " + p.Name).Trim());
                    help.Items.Add(it);
                }
                if (help.Items.Count == 0) return null;
                help.ActiveSignature = 0;
                for (int i = 0; i < help.Items.Count; i++)
                    if (help.Items[i].Parameters.Count > active) { help.ActiveSignature = i; break; }
                return help;
            }
            catch { return null; }
        }
    }
}
