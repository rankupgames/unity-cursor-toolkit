using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

/// <summary>
/// Formatted Markdown for .md files under Assets/ or Packages/&lt;name&gt;/. An Obsidian Excalidraw file shows as its drawing.
/// Links resolve only inside the logical root of the file: Assets or Packages/&lt;name&gt;.
/// <see cref="MarkdownTextAssetEditor"/> owns one <see cref="MarkdownView"/> per Inspector.
/// </summary>
internal static class MarkdownInspector
{
    private const string AssetsRoot = "Assets";
    private const string PackagesPrefix = "Packages/";

    /// <summary>True for a .md file under Assets/ or Packages/&lt;name&gt;/.</summary>
    internal static bool IsMarkdownPath(string path) =>
        path != null && LogicalRoot(path) != null && path.EndsWith(".md", StringComparison.OrdinalIgnoreCase);

    /// <summary>Returns "Assets" or "Packages/&lt;name&gt;" for an asset path below that root, otherwise null.</summary>
    internal static string LogicalRoot(string assetPath)
    {
        if (assetPath == null)
        {
            return null;
        }

        if (assetPath.StartsWith(AssetsRoot + "/", StringComparison.Ordinal))
        {
            return AssetsRoot;
        }

        int nameEnd = assetPath.StartsWith(PackagesPrefix, StringComparison.Ordinal) ? assetPath.IndexOf('/', PackagesPrefix.Length) : -1;
        return nameEnd > PackagesPrefix.Length ? assetPath.Substring(0, nameEnd) : null;
    }

    /// <summary>Returns the folder of an asset path with forward slashes, or null for a path without a folder.</summary>
    internal static string ParentFolder(string assetPath)
    {
        int slash = assetPath.LastIndexOf('/');
        return slash > 0 ? assetPath.Substring(0, slash) : null;
    }

    /// <summary>False for an empty, rooted, drive, UNC or scheme path. Such a path is never resolved.</summary>
    internal static bool IsRelativeLink(string link) =>
        !string.IsNullOrEmpty(link) && link[0] != '/' && link[0] != '\\' && link.IndexOf(':') < 0
        && link.IndexOfAny(Path.GetInvalidPathChars()) < 0 && !Path.IsPathRooted(link);

    /// <summary>
    /// Joins <paramref name="relative"/> to <paramref name="folder"/>. Returns null when the link is not relative or a ".."
    /// segment leaves <paramref name="root"/>. Works only on the logical path; it does not touch the file system.
    /// </summary>
    internal static string CombineInRoot(string folder, string relative, string root)
    {
        if (!IsRelativeLink(relative) || (folder != root && !folder.StartsWith(root + "/", StringComparison.Ordinal)))
        {
            return null;
        }

        int rootDepth = root.Split('/').Length;
        var parts = new List<string>(folder.Split('/'));
        foreach (string part in relative.Replace('\\', '/').Split('/'))
        {
            if (part == "..")
            {
                if (parts.Count <= rootDepth)
                {
                    return null;
                }

                parts.RemoveAt(parts.Count - 1);
            }
            else if (part.Length > 0 && part != ".")
            {
                parts.Add(part);
            }
        }

        return parts.Count > rootDepth ? string.Join("/", parts) : null;
    }

    /// <summary>Maps a validated Unity path to its source file, including Git and registry packages.</summary>
    internal static string SourcePath(string assetPath)
    {
        string root = LogicalRoot(assetPath);
        if (root == null || CombineInRoot(root, assetPath.Substring(root.Length + 1), root) != assetPath)
        {
            throw new InvalidDataException($"{assetPath}: expected a canonical Assets/ or Packages/<name>/ path.");
        }

        string sourceRoot;
        if (root == AssetsRoot)
        {
            sourceRoot = Application.dataPath;
        }
        else
        {
            UnityEditor.PackageManager.PackageInfo package = UnityEditor.PackageManager.PackageInfo.FindForAssetPath(assetPath);
            if (package == null || package.assetPath != root || string.IsNullOrEmpty(package.resolvedPath))
            {
                throw new InvalidDataException($"{assetPath}: Unity cannot resolve the package source. Resolve the package before importing this file.");
            }

            sourceRoot = package.resolvedPath;
        }

        // Reject redirects below the trusted root. A package root itself may be outside the project.
        string current = Path.GetFullPath(sourceRoot);
        foreach (string part in assetPath.Substring(root.Length + 1).Split('/'))
        {
            current = Path.Combine(current, part);
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException($"{assetPath}: a symbolic link leaves the documentation boundary. Use files inside the asset root.");
            }
        }

        return current;
    }

    private enum LinkAction
    {
        None,
        OpenUrl,
        SelectAsset,
        Unresolved,
    }

    private struct TextItem
    {
        public Rect Rect;
        public string Text;
        public GUIStyle Style;
        public Color Color;
        public LinkAction Action;
        public string Target;
    }

    private struct FillItem
    {
        public Rect Rect;
        public Color Color;
    }

    private sealed class EmbedItem
    {
        public Rect Rect;
        public ExcalidrawDrawing Drawing;
        public ExcalidrawCanvas Canvas;
        public Texture2D Texture;
        public string Message;
        public MessageType MessageType;
    }

    /// <summary>Parsed blocks and the cached layout of one Markdown file.</summary>
    internal sealed class MarkdownView
    {
        private const float Margin = 8f;
        private const float BlockSpacing = 8f;
        private const float TightSpacing = 2f;
        private const float ListIndent = 18f;
        private const float QuoteIndent = 12f;
        private const float CodePadding = 6f;
        private const float CellPadding = 4f;
        private const float FitButtonHeight = 18f;
        private static readonly int[] HeadingSizeIncrease = { 10, 6, 4, 2, 1, 0 };
        private static readonly Dictionary<int, GUIStyle> Styles = new Dictionary<int, GUIStyle>();
        private static readonly GUIContent Content = new GUIContent();
        private static GUIStyle _codeBlockStyle;

        private readonly string _path;
        private readonly List<MarkdownBlock> _blocks;
        private readonly string _loadError;
        private readonly List<TextItem> _texts = new List<TextItem>();
        private readonly List<FillItem> _fills = new List<FillItem>();
        private readonly List<EmbedItem> _embeds = new List<EmbedItem>();
        private readonly List<ExcalidrawCanvas> _canvases = new List<ExcalidrawCanvas>();
        private Dictionary<string, List<string>> _assetPathsByFileName;
        private float _layoutWidth = -1f;
        private float _measuredWidth = -1f;
        private float _height;
        // Set for an Obsidian Excalidraw file; the view owns this drawing and shows it in place of the Markdown.
        private ExcalidrawDrawing _obsidianDrawing;
        private readonly InspectorHost _host = new InspectorHost();

        public MarkdownView(string path)
        {
            _path = path;
            TextAsset asset = AssetDatabase.LoadAssetAtPath<TextAsset>(path);
            if (asset == null)
            {
                _loadError = $"{path} is not imported as a text asset, so it cannot be shown as Markdown.";
                return;
            }

            string text = asset.text.Replace("\r\n", "\n");
            if (!IsObsidianDrawing(path, text))
            {
                _blocks = MarkdownParser.Parse(text);
                return;
            }

            _obsidianDrawing = ScriptableObject.CreateInstance<ExcalidrawDrawing>();
            _obsidianDrawing.hideFlags = HideFlags.HideAndDontSave;
            string drawingJson = ObsidianDrawingJson(text, out string drawingError);
            if (drawingJson == null)
            {
                _obsidianDrawing.ImportError = drawingError;
                return;
            }

            try
            {
                ExcalidrawImporter.Parse(drawingJson, _obsidianDrawing, fileId => ResolveDrawingImage(text, fileId));
            }
            catch (Exception exception) when (exception is Newtonsoft.Json.JsonException || exception is InvalidDataException)
            {
                _obsidianDrawing.Elements.Clear();
                _obsidianDrawing.ImportError = exception.Message;
            }
        }

        public void Dispose()
        {
            if (_obsidianDrawing != null)
            {
                Object.DestroyImmediate(_obsidianDrawing);
            }
        }

        private string ResolveDrawingImage(string text, string fileId)
        {
            int section = text.IndexOf("\n# Embedded files\n", StringComparison.Ordinal);
            int drawing = section < 0 ? -1 : text.IndexOf("\n# Drawing\n", section, StringComparison.Ordinal);
            string prefix = "\n" + fileId + ": [[";
            int start = section < 0 ? -1 : text.IndexOf(prefix, section, StringComparison.Ordinal);
            int end = start < 0 ? -1 : text.IndexOf("]]", start + prefix.Length, StringComparison.Ordinal);
            if (start < 0 || drawing < 0 || start >= drawing || end < 0 || end >= drawing)
            {
                throw new InvalidDataException($"Image {fileId}: no file link exists in the Embedded files section.");
            }

            string name = text.Substring(start + prefix.Length, end - start - prefix.Length);
            // A file that Unity cannot decode (for example WebP data) still resolves; the canvas then shows its name.
            string path = ResolveWikiTarget(name);
            if (path == null)
            {
                throw new InvalidDataException($"Image {fileId}: {name} does not resolve to one asset.");
            }

            return path;
        }

        /// <summary>True for a file of the Obsidian Excalidraw plugin: a .excalidraw.md name or an excalidraw-plugin frontmatter key.</summary>
        private static bool IsObsidianDrawing(string path, string text)
        {
            if (path.EndsWith(".excalidraw.md", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (!text.StartsWith("---\n", StringComparison.Ordinal))
            {
                return false;
            }

            int frontmatterEnd = text.IndexOf("\n---", 3, StringComparison.Ordinal);
            string frontmatter = frontmatterEnd < 0 ? string.Empty : text.Substring(4, Math.Max(0, frontmatterEnd - 4));
            return frontmatter.Split('\n').Any(line => line.StartsWith("excalidraw-plugin:", StringComparison.Ordinal));
        }

        /// <summary>Returns the JSON block below the "# Drawing" heading, or null with the reason in <paramref name="error"/>.</summary>
        private static string ObsidianDrawingJson(string text, out string error)
        {
            int section = text.IndexOf("\n# Drawing\n", StringComparison.Ordinal);
            int fence = section < 0 ? -1 : text.IndexOf("\n```", section, StringComparison.Ordinal);
            if (fence < 0)
            {
                error = "This Obsidian Excalidraw file has no drawing data: no code block below the \"# Drawing\" heading.";
                return null;
            }

            int lineEnd = text.IndexOf('\n', fence + 1);
            string language = lineEnd < 0 ? string.Empty : text.Substring(fence + 4, lineEnd - fence - 4).Trim();
            if (language == "compressed-json")
            {
                error = "This drawing is saved as compressed JSON, which cannot be shown. In Obsidian, turn off \"Compress Excalidraw JSON in Markdown\" and save the drawing again.";
                return null;
            }

            int end = lineEnd < 0 ? -1 : text.IndexOf("\n```", lineEnd, StringComparison.Ordinal);
            if (language != "json" || end < 0)
            {
                error = "The drawing data below the \"# Drawing\" heading is not a complete json code block.";
                return null;
            }

            error = null;
            return text.Substring(lineEnd + 1, end - lineEnd - 1);
        }

        private static bool IsProSkin => EditorGUIUtility.isProSkin;
        private static Color TextColor => EditorStyles.label.normal.textColor;
        private static Color LinkColor => EditorStyles.linkLabel.normal.textColor;
        private static Color UnresolvedLinkColor => IsProSkin ? new Color(0.9f, 0.5f, 0.5f) : new Color(0.7f, 0.2f, 0.2f);
        private static Color RuleColor => IsProSkin ? new Color(1f, 1f, 1f, 0.18f) : new Color(0f, 0f, 0f, 0.18f);
        private static Color HighlightColor => new Color(1f, 0.82f, 0f, 0.35f);
        private static Color CodeBackground => IsProSkin ? new Color(1f, 1f, 1f, 0.07f) : new Color(0f, 0f, 0f, 0.06f);
        private static int BaseFontSize => EditorStyles.label.fontSize > 0 ? EditorStyles.label.fontSize : 12;

        public void OnGUI(Editor editor)
        {
            if (_loadError != null)
            {
                EditorGUILayout.HelpBox(_loadError, MessageType.Error);
                return;
            }

            if (_obsidianDrawing != null)
            {
                if (_canvases.Count == 0)
                {
                    _canvases.Add(new ExcalidrawCanvas());
                    _canvases[0].RequestFit();
                }

                ExcalidrawImporterEditor.DrawFullCanvas(_canvases[0], _obsidianDrawing, _host, editor);
                return;
            }

            if (_host.Diagnostic != null)
            {
                EditorGUILayout.HelpBox(_host.Diagnostic, MessageType.Warning);
            }

            // The Inspector disables GUI for imported assets; links and embedded drawings stay interactive.
            bool wasEnabled = GUI.enabled;
            GUI.enabled = true;
            float width = Mathf.Max(100f, _measuredWidth > 0f ? _measuredWidth : EditorGUIUtility.currentViewWidth - Margin * 2f - 24f);
            if (!Mathf.Approximately(width, _layoutWidth))
            {
                Layout(width);
            }

            Rect area = GUILayoutUtility.GetRect(0f, _height + Margin * 2f, GUILayout.ExpandWidth(true));
            Rect content = new Rect(area.x + Margin, area.y + Margin, Mathf.Max(0f, area.width - Margin * 2f), _height);
            if (Event.current.type == EventType.Repaint)
            {
                _host.Locate(area);
                if (Mathf.Abs(content.width - _measuredWidth) > 0.5f)
                {
                    _measuredWidth = content.width;
                    editor.Repaint();
                }
            }

            GUI.BeginClip(content);
            Draw(Vector2.zero, editor);
            GUI.EndClip();
            GUI.enabled = wasEnabled;
        }

        private void Draw(Vector2 origin, Editor editor)
        {
            Event current = Event.current;
            foreach (EmbedItem embed in _embeds)
            {
                Rect rect = new Rect(embed.Rect.position + origin, embed.Rect.size);
                if (embed.Message != null)
                {
                    EditorGUI.HelpBox(rect, embed.Message, embed.MessageType);
                    continue;
                }

                if (embed.Texture != null)
                {
                    if (current.type == EventType.Repaint)
                    {
                        GUI.DrawTexture(rect, embed.Texture, ScaleMode.StretchToFill);
                    }

                    continue;
                }

                if (GUI.Button(new Rect(rect.xMax - 48f, rect.y, 48f, FitButtonHeight - 2f), "Fit", EditorStyles.miniButton))
                {
                    embed.Canvas.RequestFit();
                }

                if (embed.Canvas.Draw(new Rect(rect.x, rect.y + FitButtonHeight, rect.width, rect.height - FitButtonHeight), embed.Drawing))
                {
                    editor.Repaint();
                }
            }

            if (current.type == EventType.MouseDown && current.button == 0)
            {
                foreach (TextItem text in _texts)
                {
                    if ((text.Action == LinkAction.OpenUrl || text.Action == LinkAction.SelectAsset)
                        && new Rect(text.Rect.position + origin, text.Rect.size).Contains(current.mousePosition))
                    {
                        OpenLink(text.Action, text.Target);
                        current.Use();
                        return;
                    }
                }
            }

            if (current.type != EventType.Repaint)
            {
                return;
            }

            // A long document has many items; only the items in the window are drawn.
            Rect visible = _host.VisibleRect;
            foreach (FillItem fill in _fills)
            {
                Rect rect = new Rect(fill.Rect.position + origin, fill.Rect.size);
                if (rect.Overlaps(visible))
                {
                    EditorGUI.DrawRect(rect, fill.Color);
                }
            }

            foreach (TextItem text in _texts)
            {
                Rect rect = new Rect(text.Rect.position + origin, text.Rect.size);
                if (!rect.Overlaps(visible))
                {
                    continue;
                }

                text.Style.normal.textColor = text.Color;
                GUI.Label(rect, text.Text, text.Style);
                if (text.Action == LinkAction.OpenUrl || text.Action == LinkAction.SelectAsset)
                {
                    EditorGUIUtility.AddCursorRect(rect, MouseCursor.Link);
                }
            }
        }

        private static void OpenLink(LinkAction action, string target)
        {
            if (action == LinkAction.OpenUrl)
            {
                Application.OpenURL(target);
                return;
            }

            Object asset = AssetDatabase.LoadMainAssetAtPath(target);
            if (asset != null)
            {
                Selection.activeObject = asset;
                EditorGUIUtility.PingObject(asset);
            }
        }

        private void Layout(float width)
        {
            _layoutWidth = width;
            _texts.Clear();
            _fills.Clear();
            _embeds.Clear();
            float y = 0f;
            LayoutBlocks(_blocks, 0f, width, ref y, false, 0);
            _height = y;
        }

        private void LayoutBlocks(List<MarkdownBlock> blocks, float x, float width, ref float y, bool tight, int listDepth)
        {
            for (int index = 0; index < blocks.Count; index++)
            {
                MarkdownBlock block = blocks[index];
                if (index > 0)
                {
                    y += tight ? TightSpacing : BlockSpacing;
                }

                switch (block.Kind)
                {
                    case MarkdownBlockKind.Paragraph:
                        y = FlowInline(block.Spans, x, width, y, BaseFontSize, false, TextColor);
                        break;
                    case MarkdownBlockKind.Heading:
                        if (y > 0f)
                        {
                            y += 6f;
                        }

                        Color headingColor = block.HeadingLevel == 6 ? new Color(TextColor.r, TextColor.g, TextColor.b, 0.7f) : TextColor;
                        y = FlowInline(block.Spans, x, width, y, BaseFontSize + HeadingSizeIncrease[block.HeadingLevel - 1], true, headingColor);
                        if (block.HeadingLevel <= 2)
                        {
                            y += 3f;
                            AddFill(new Rect(x, y, width, 1f), RuleColor);
                            y += 1f;
                        }

                        break;
                    case MarkdownBlockKind.Code:
                        LayoutCode(block.CodeText, x, width, ref y);
                        break;
                    case MarkdownBlockKind.Quote:
                        float quoteTop = y;
                        LayoutBlocks(block.Children, x + QuoteIndent, width - QuoteIndent, ref y, tight, listDepth);
                        AddFill(new Rect(x, quoteTop, 3f, Mathf.Max(y - quoteTop, LineHeight(BaseFontSize))), RuleColor);
                        break;
                    case MarkdownBlockKind.List:
                        LayoutList(block, x, width, ref y, listDepth);
                        break;
                    case MarkdownBlockKind.Rule:
                        y += 4f;
                        AddFill(new Rect(x, y, width, 1f), RuleColor);
                        y += 5f;
                        break;
                    case MarkdownBlockKind.Table:
                        LayoutTable(block, x, width, ref y);
                        break;
                    case MarkdownBlockKind.Embed:
                        LayoutEmbed(block, x, width, ref y);
                        break;
                }
            }
        }

        private void LayoutCode(string code, float x, float width, ref float y)
        {
            _codeBlockStyle = _codeBlockStyle ?? new GUIStyle(GetStyle(BaseFontSize - 1, false, false, true)) { wordWrap = true };
            float innerWidth = Mathf.Max(1f, width - CodePadding * 2f);
            float top = y;
            y += CodePadding;
            foreach (string line in code.Replace("\t", "    ").Split('\n'))
            {
                Content.text = line.Length == 0 ? " " : line;
                float lineHeight = _codeBlockStyle.CalcHeight(Content, innerWidth);
                if (line.Length > 0)
                {
                    AddText(new Rect(x + CodePadding, y, innerWidth, lineHeight), line, _codeBlockStyle, TextColor);
                }

                y += lineHeight;
            }

            y += CodePadding;
            AddFill(new Rect(x, top, width, y - top), CodeBackground);
        }

        private void LayoutList(MarkdownBlock list, float x, float width, ref float y, int listDepth)
        {
            GUIStyle markerStyle = GetStyle(BaseFontSize, false, false, false);
            for (int index = 0; index < list.ListItems.Count; index++)
            {
                if (index > 0)
                {
                    y += TightSpacing;
                }

                string marker = list.Ordered ? $"{list.FirstNumber + index}." : listDepth % 2 == 0 ? "•" : "◦";
                Vector2 markerSize = Measure(markerStyle, marker);
                float indent = Mathf.Max(ListIndent, markerSize.x + 6f);
                AddText(new Rect(x + indent - 6f - markerSize.x, y + LineHeight(BaseFontSize) - markerSize.y, markerSize.x, markerSize.y), marker, markerStyle, TextColor);
                float itemTop = y;
                LayoutBlocks(list.ListItems[index], x + indent, width - indent, ref y, true, listDepth + 1);
                y = Mathf.Max(y, itemTop + LineHeight(BaseFontSize));
            }
        }

        private void LayoutTable(MarkdownBlock table, float x, float width, ref float y)
        {
            List<List<List<MarkdownSpan>>> rows = table.TableRows;
            int columns = rows[0].Count;
            float[] columnWidths = new float[columns];
            for (int row = 0; row < rows.Count; row++)
            {
                GUIStyle style = GetStyle(BaseFontSize, row == 0, false, false);
                for (int column = 0; column < columns; column++)
                {
                    float natural = rows[row][column].Sum(span => Measure(span.Code ? GetStyle(BaseFontSize - 1, row == 0, span.Italic, true) : style, span.Text).x);
                    columnWidths[column] = Mathf.Max(columnWidths[column], natural + CellPadding * 2f + 2f);
                }
            }

            if (columnWidths.Sum() > width)
            {
                // Narrow columns keep their width; the wide columns share the remaining width equally.
                float remaining = width;
                int left = columns;
                float minimumColumnWidth = Mathf.Min(CellPadding * 2f + 1f, Mathf.Max(0f, width) / columns);
                foreach (int column in Enumerable.Range(0, columns).OrderBy(index => columnWidths[index]))
                {
                    columnWidths[column] = Mathf.Max(minimumColumnWidth, Mathf.Min(columnWidths[column], remaining / left));
                    remaining -= columnWidths[column];
                    left--;
                }
            }

            float tableWidth = columnWidths.Sum();
            float tableTop = y;
            var rowEdges = new List<float> { y };
            for (int row = 0; row < rows.Count; row++)
            {
                float rowTop = y;
                float rowBottom = rowTop + LineHeight(BaseFontSize) + CellPadding * 2f;
                float cellX = x;
                for (int column = 0; column < columns; column++)
                {
                    float horizontalPadding = Mathf.Min(CellPadding, Mathf.Max(0f, (columnWidths[column] - 1f) / 2f));
                    float cellBottom = FlowInline(rows[row][column], cellX + horizontalPadding, Mathf.Max(0f, columnWidths[column] - horizontalPadding * 2f), rowTop + CellPadding, BaseFontSize, row == 0, TextColor);
                    rowBottom = Mathf.Max(rowBottom, cellBottom + CellPadding);
                    cellX += columnWidths[column];
                }

                if (row == 0)
                {
                    AddFill(new Rect(x, rowTop, tableWidth, rowBottom - rowTop), CodeBackground);
                }

                y = rowBottom;
                rowEdges.Add(y);
            }

            foreach (float edge in rowEdges)
            {
                AddFill(new Rect(x, edge, tableWidth, 1f), RuleColor);
            }

            float lineX = x;
            for (int column = 0; column <= columns; column++)
            {
                AddFill(new Rect(lineX, tableTop, 1f, y - tableTop + 1f), RuleColor);
                lineX += column < columns ? columnWidths[column] : 0f;
            }

            y += 1f;
        }

        private void LayoutEmbed(MarkdownBlock block, float x, float width, ref float y)
        {
            string path = block.EmbedIsPath ? ResolveRelativePath(block.EmbedTarget) : ResolveWikiTarget(block.EmbedTarget);
            Texture2D texture = path == null ? null : AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (texture != null)
            {
                // The imported texture can have another size than the source file; the source size keeps the aspect ratio.
                int sourceWidth = texture.width;
                int sourceHeight = texture.height;
                (AssetImporter.GetAtPath(path) as TextureImporter)?.GetSourceTextureWidthAndHeight(out sourceWidth, out sourceHeight);
                float imageWidth = Mathf.Min(width, sourceWidth);
                float imageHeight = imageWidth * sourceHeight / sourceWidth;
                _embeds.Add(new EmbedItem { Rect = new Rect(x, y, imageWidth, imageHeight), Texture = texture });
                y += imageHeight;
                return;
            }

            if (path == null || !path.EndsWith(".excalidraw", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".canvas", StringComparison.OrdinalIgnoreCase))
            {
                if (path != null)
                {
                    var link = new MarkdownSpan { Text = block.EmbedTarget, Link = block.EmbedTarget, IsWikiLink = !block.EmbedIsPath };
                    y = FlowInline(new List<MarkdownSpan> { link }, x, width, y, BaseFontSize, false, TextColor);
                    return;
                }

                AddMessage($"No single asset matches the embed {block.EmbedTarget}.", MessageType.Warning, x, width, ref y);
                return;
            }

            ExcalidrawDrawing drawing = AssetDatabase.LoadAssetAtPath<ExcalidrawDrawing>(path);
            if (drawing == null)
            {
                AddMessage($"{path} is not imported as an Excalidraw drawing.", MessageType.Error, x, width, ref y);
                return;
            }

            string status = ExcalidrawImporterEditor.StatusMessage(drawing, out MessageType statusType);
            if (status != null)
            {
                AddMessage($"{path}: {status}", statusType, x, width, ref y);
                return;
            }

            int canvasIndex = _embeds.Count(embed => embed.Canvas != null);
            if (canvasIndex == _canvases.Count)
            {
                _canvases.Add(new ExcalidrawCanvas());
            }

            ExcalidrawCanvas canvas = _canvases[canvasIndex];
            canvas.RequestFit();
            float height = FitButtonHeight + Mathf.Clamp(width * 0.6f, 240f, 480f);
            _embeds.Add(new EmbedItem { Rect = new Rect(x, y, width, height), Drawing = drawing, Canvas = canvas });
            y += height;
        }

        private void AddMessage(string message, MessageType type, float x, float width, ref float y)
        {
            Content.text = message;
            float height = Mathf.Max(40f, EditorStyles.helpBox.CalcHeight(Content, width - 40f));
            _embeds.Add(new EmbedItem { Rect = new Rect(x, y, width, height), Message = message, MessageType = type });
            y += height;
        }

        /// <summary>Places words of <paramref name="spans"/> left to right with wrapping. Returns the bottom of the last line.</summary>
        private float FlowInline(List<MarkdownSpan> spans, float x, float width, float y, int fontSize, bool bold, Color color)
        {
            float lineHeight = LineHeight(fontSize);
            float right = x + width;
            float cursor = x;
            bool lineHasContent = false;
            foreach (MarkdownSpan span in spans)
            {
                if (span.Text == "\n")
                {
                    cursor = x;
                    y += lineHeight;
                    lineHasContent = false;
                    continue;
                }

                (LinkAction action, string target) = ResolveLink(span);
                GUIStyle style = GetStyle(span.Code ? fontSize - 1 : fontSize, bold || span.Bold, span.Italic, span.Code);
                Color spanColor = action == LinkAction.None ? color : action == LinkAction.Unresolved ? UnresolvedLinkColor : LinkColor;
                float spaceWidth = Measure(style, "a a").x - Measure(style, "aa").x;
                int position = 0;
                while (position < span.Text.Length)
                {
                    if (span.Text[position] == ' ')
                    {
                        cursor += lineHasContent ? spaceWidth : 0f;
                        position++;
                        continue;
                    }

                    int end = span.Text.IndexOf(' ', position);
                    end = end < 0 ? span.Text.Length : end;
                    string word = span.Text.Substring(position, end - position);
                    Vector2 size = Measure(style, word);
                    if (lineHasContent && cursor + size.x > right)
                    {
                        cursor = x;
                        y += lineHeight;
                    }

                    // A word wider than the line is split, so that it stays in the width.
                    if (cursor + size.x > right && word.Length > 1)
                    {
                        end = position + FittingLength(style, word, right - cursor);
                        word = span.Text.Substring(position, end - position);
                        size = Measure(style, word);
                    }

                    Rect rect = new Rect(cursor, y + lineHeight - size.y, Mathf.Clamp(right - cursor, 0f, size.x), size.y);
                    if (span.Highlight)
                    {
                        AddFill(rect, HighlightColor);
                    }

                    if (span.Code)
                    {
                        AddFill(new Rect(rect.x - 2f, rect.y, rect.width + 4f, rect.height), CodeBackground);
                    }

                    if (action != LinkAction.None)
                    {
                        AddFill(new Rect(rect.x, rect.yMax - 1f, rect.width, 1f), spanColor);
                    }

                    _texts.Add(new TextItem { Rect = rect, Text = word, Style = style, Color = spanColor, Action = action, Target = target });
                    cursor += size.x;
                    lineHasContent = true;
                    position = end;
                }
            }

            return y + lineHeight;
        }

        /// <summary>Returns the length of the longest start of <paramref name="word"/> that fits, with a minimum of one character.</summary>
        private static int FittingLength(GUIStyle style, string word, float available)
        {
            int low = 1;
            int high = word.Length - 1;
            while (low < high)
            {
                int middle = (low + high + 1) / 2;
                if (Measure(style, word.Substring(0, middle)).x <= available)
                {
                    low = middle;
                }
                else
                {
                    high = middle - 1;
                }
            }

            return char.IsHighSurrogate(word[low - 1]) ? low + 1 : low;
        }

        private (LinkAction, string) ResolveLink(MarkdownSpan span)
        {
            if (span.Link == null)
            {
                return (LinkAction.None, null);
            }

            if (span.IsWikiLink)
            {
                int heading = span.Link.IndexOf('#');
                if (heading == 0)
                {
                    return (LinkAction.None, null);
                }

                string wikiPath = ResolveWikiTarget(span.Link);
                return wikiPath != null ? (LinkAction.SelectAsset, wikiPath) : (LinkAction.Unresolved, null);
            }

            if (span.Link.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || span.Link.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            {
                return (LinkAction.OpenUrl, span.Link);
            }

            if (span.Link.Contains(":") || span.Link.StartsWith("#", StringComparison.Ordinal))
            {
                return (LinkAction.None, null);
            }

            string relativePath = ResolveRelativePath(span.Link);
            return relativePath != null ? (LinkAction.SelectAsset, relativePath) : (LinkAction.Unresolved, null);
        }

        /// <summary>Resolves a relative link inside the logical root of this file. Returns null when no imported asset exists there.</summary>
        private string ResolveRelativePath(string link)
        {
            int anchor = link.IndexOf('#');
            string target = Uri.UnescapeDataString(anchor < 0 ? link : link.Substring(0, anchor));
            string root = LogicalRoot(_path);
            string folder = ParentFolder(_path);
            string path = root == null || folder == null ? null : CombineInRoot(folder, target, root);
            return path != null && AssetDatabase.GetMainAssetTypeAtPath(path) != null ? path : null;
        }

        /// <summary>
        /// Resolves an Obsidian link target to the one asset with that file name in the logical root of this file. Without an extension,
        /// it matches .md, .excalidraw, .excalidraw.md and .canvas files. Returns null when no asset or more than one asset matches.
        /// </summary>
        private string ResolveWikiTarget(string target)
        {
            int heading = target.IndexOf('#');
            string name = (heading < 0 ? target : target.Substring(0, heading)).Trim().Replace('\\', '/');
            if (name.Length == 0)
            {
                return null;
            }

            if (_assetPathsByFileName == null)
            {
                // The view is reset on projectChanged, so this index is built at most once per project change.
                string rootPrefix = LogicalRoot(_path) + "/";
                _assetPathsByFileName = AssetDatabase.GetAllAssetPaths()
                    .Where(assetPath => assetPath.StartsWith(rootPrefix, StringComparison.Ordinal) && Path.HasExtension(assetPath))
                    .GroupBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.OrdinalIgnoreCase);
            }

            List<string> matches = Matches(name);
            if (matches.Count == 0)
            {
                matches = new[] { ".md", ".excalidraw", ".excalidraw.md", ".canvas" }.SelectMany(extension => Matches(name + extension)).ToList();
            }

            return matches.Count == 1 ? matches[0] : null;
        }

        private List<string> Matches(string name)
        {
            if (!_assetPathsByFileName.TryGetValue(Path.GetFileName(name), out List<string> paths))
            {
                return new List<string>();
            }

            return name.Contains('/') ? paths.Where(assetPath => assetPath.EndsWith("/" + name, StringComparison.OrdinalIgnoreCase)).ToList() : paths;
        }

        private void AddText(Rect rect, string text, GUIStyle style, Color color) =>
            _texts.Add(new TextItem { Rect = rect, Text = text, Style = style, Color = color });

        private void AddFill(Rect rect, Color color) => _fills.Add(new FillItem { Rect = rect, Color = color });

        private static float LineHeight(int fontSize) => Mathf.Ceil(fontSize * 1.5f);

        private static Vector2 Measure(GUIStyle style, string text)
        {
            Content.text = text;
            return style.CalcSize(Content);
        }

        private static GUIStyle GetStyle(int fontSize, bool bold, bool italic, bool code)
        {
            int key = fontSize * 8 + (bold ? 1 : 0) + (italic ? 2 : 0) + (code ? 4 : 0);
            if (!Styles.TryGetValue(key, out GUIStyle style))
            {
                style = new GUIStyle(EditorStyles.label)
                {
                    fontSize = fontSize,
                    fontStyle = bold && italic ? FontStyle.BoldAndItalic : bold ? FontStyle.Bold : italic ? FontStyle.Italic : FontStyle.Normal,
                    wordWrap = false,
                    richText = false,
                    clipping = TextClipping.Clip,
                    padding = new RectOffset(),
                    margin = new RectOffset(),
                };
                if (code && ExcalidrawCanvas.MonospaceFont != null)
                {
                    style.font = ExcalidrawCanvas.MonospaceFont;
                }

                Styles[key] = style;
            }

            return style;
        }
    }
}
