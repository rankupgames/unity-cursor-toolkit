using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
#if UNITY_2020_2_OR_NEWER
using UnityEditor.AssetImporters;
#else
using UnityEditor.Experimental.AssetImporters;
#endif
using UnityEngine;

/// <summary>
/// Imports Obsidian JSON Canvas (.canvas) documents as <see cref="ExcalidrawDrawing"/> assets.
/// File paths are relative to the vault root: the nearest folder above the canvas that contains the file.
/// The search stops at the logical root of the canvas: Assets or Packages/&lt;name&gt;.
/// Text nodes show their Markdown source as plain text.
/// </summary>
[ScriptedImporter(2, "canvas")]
public sealed class ObsidianCanvasImporter : ScriptedImporter
{
    private const float NodePadding = 8f;
    private const float NodeFontSize = 16f;
    private const float GroupLabelFontSize = 18f;
    private const float EdgeLabelFontSize = 14f;
    private const int EdgeSamples = 24;

    private static readonly Color Background = new Color32(0x1e, 0x1e, 0x1e, 0xff);
    private static readonly Color NodeFill = new Color32(0x26, 0x26, 0x26, 0xff);
    private static readonly Color NodeStroke = new Color32(0x6b, 0x6b, 0x6b, 0xff);
    private static readonly Color TextColor = new Color32(0xda, 0xda, 0xda, 0xff);
    private static readonly Color EdgeColor = new Color32(0xa0, 0xa0, 0xa0, 0xff);

    // Obsidian preset colors "1" to "6".
    private static readonly Color[] PresetColors =
    {
        new Color32(0xfb, 0x46, 0x4c, 0xff), new Color32(0xe9, 0x97, 0x3f, 0xff), new Color32(0xe0, 0xde, 0x71, 0xff),
        new Color32(0x44, 0xcf, 0x6e, 0xff), new Color32(0x53, 0xdf, 0xdd, 0xff), new Color32(0xa8, 0x82, 0xff, 0xff),
    };

    private static readonly HashSet<string> ImageExtensions = new HashSet<string>
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tga", ".psd", ".tif", ".tiff", ".exr", ".hdr",
    };

    private static readonly string[] Sides = { "top", "right", "bottom", "left" };

    private sealed class CanvasNode
    {
        public string Id;
        public string Type;
        public Rect Bounds;
        public Color? Color;
        public JObject Source;
    }

    public override void OnImportAsset(AssetImportContext ctx) =>
        ExcalidrawImporter.Import(ctx, (source, drawing) => Parse(source, drawing, ctx.assetPath, path =>
        {
            ctx.DependsOnSourceAsset(path);
#if UNITY_2020_1_OR_NEWER
            // Artifact dependencies also track paths that have not yet been imported.
            // Existing links need only their source hash; this avoids cycles between linked canvases.
            if (!File.Exists(MarkdownInspector.SourcePath(path)))
            {
                ctx.DependsOnArtifact(path);
            }
#endif
        }));

    /// <summary>
    /// Fills <paramref name="drawing"/> from JSON Canvas. Calls <paramref name="dependsOn"/> for each referenced file.
    /// Throws JsonException or InvalidDataException for a malformed document or a missing file.
    /// </summary>
    internal static void Parse(string source, ExcalidrawDrawing drawing, string canvasPath, System.Action<string> dependsOn)
    {
        if (!(JToken.Parse(source, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error }) is JObject document))
        {
            throw new InvalidDataException("The file is not a JSON Canvas document: the top level is not an object.");
        }

        drawing.Background = Background;
        Dictionary<string, CanvasNode> nodes = new Dictionary<string, CanvasNode>();
        foreach (JObject nodeObject in ReadObjects(document, "nodes"))
        {
            CanvasNode node = ReadNode(nodeObject);
            if (nodes.ContainsKey(node.Id))
            {
                throw new InvalidDataException($"Node {node.Id}: the id is not unique.");
            }

            nodes.Add(node.Id, node);
        }

        List<ExcalidrawElement> edgeElements = new List<ExcalidrawElement>();
        List<ExcalidrawElement> edgeLabels = new List<ExcalidrawElement>();
        HashSet<string> edgeIds = new HashSet<string>();
        foreach (JObject edgeObject in ReadObjects(document, "edges"))
        {
            string edgeId = ReadString(edgeObject, "id", "An edge", true);
            if (string.IsNullOrWhiteSpace(edgeId))
            {
                throw new InvalidDataException("An edge id is empty.");
            }

            if (nodes.ContainsKey(edgeId) || !edgeIds.Add(edgeId))
            {
                throw new InvalidDataException($"Edge {edgeId}: the id is not unique.");
            }

            AddEdge(edgeObject, nodes, edgeElements, edgeLabels);
        }

        // Larger groups first, so nested groups paint over their parents. Edges paint under the cards they join.
        foreach (CanvasNode group in nodes.Values.Where(node => node.Type == "group").OrderByDescending(node => node.Bounds.width * node.Bounds.height))
        {
            AddGroup(group, drawing.Elements, canvasPath, dependsOn);
        }

        drawing.Elements.AddRange(edgeElements);
        foreach (CanvasNode node in nodes.Values.Where(node => node.Type != "group"))
        {
            AddCard(node, drawing.Elements, canvasPath, dependsOn);
        }

        drawing.Elements.AddRange(edgeLabels);
        ExcalidrawImporter.UpdateContentBounds(drawing);
    }

    private static IEnumerable<JObject> ReadObjects(JObject document, string name)
    {
        JToken token = document[name];
        // JSON Canvas permits either array to be omitted. A present value must be an array.
        if (token == null)
        {
            return Enumerable.Empty<JObject>();
        }

        if (!(token is JArray array))
        {
            throw new InvalidDataException($"\"{name}\" is not an array.");
        }

        return array.Select((item, index) => item as JObject
            ?? throw new InvalidDataException($"Item {index} of \"{name}\" is not a JSON object."));
    }

    private static CanvasNode ReadNode(JObject node)
    {
        string id = ReadString(node, "id", "A node", true);
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new InvalidDataException("A node id is empty.");
        }

        string type = ReadString(node, "type", $"Node {id}", true);
        string owner = $"Node {id}";
        switch (type)
        {
            case "text": ReadString(node, "text", owner, true); break;
            case "file": ReadString(node, "file", owner, true); break;
            case "link": ReadString(node, "url", owner, true); break;
            case "group": break;
            default: throw new InvalidDataException($"{owner}: the type \"{type}\" is not text, file, link or group.");
        }

        float width = ReadNumber(node, "width", owner);
        float height = ReadNumber(node, "height", owner);
        if (width < 0f || height < 0f)
        {
            throw new InvalidDataException($"{owner}: the width or height is negative.");
        }

        return new CanvasNode
        {
            Id = id,
            Type = type,
            Bounds = new Rect(ReadNumber(node, "x", owner), ReadNumber(node, "y", owner), width, height),
            Color = ReadColor(node, owner),
            Source = node,
        };
    }

    private static void AddGroup(CanvasNode group, List<ExcalidrawElement> elements, string canvasPath, System.Action<string> dependsOn)
    {
        Color stroke = group.Color ?? NodeStroke;
        elements.Add(new ExcalidrawElement
        {
            Shape = ExcalidrawShape.Rectangle,
            Bounds = group.Bounds,
            WorldBounds = group.Bounds,
            Stroke = stroke,
            Fill = new Color(stroke.r, stroke.g, stroke.b, 0.06f),
            StrokeWidth = 2f,
        });

        string background = ReadString(group.Source, "background", $"Node {group.Id}", false);
        if (background != null)
        {
            string path = ResolveFile(background, canvasPath, $"Node {group.Id}", dependsOn);
            elements.Add(new ExcalidrawElement
            {
                Shape = ExcalidrawShape.Image,
                Text = Path.GetFileName(path),
                Bounds = group.Bounds,
                WorldBounds = group.Bounds,
                Stroke = TextColor,
                FontSize = NodeFontSize,
                Link = path,
            });
        }

        string label = ReadString(group.Source, "label", $"Node {group.Id}", false);
        if (!string.IsNullOrEmpty(label))
        {
            Rect labelBounds = new Rect(group.Bounds.x, group.Bounds.y - GroupLabelFontSize - 10f, group.Bounds.width, GroupLabelFontSize + 6f);
            elements.Add(TextElement(label, labelBounds, group.Color ?? TextColor, GroupLabelFontSize, TextAnchor.LowerLeft, false));
        }
    }

    private static void AddCard(CanvasNode node, List<ExcalidrawElement> elements, string canvasPath, System.Action<string> dependsOn)
    {
        string owner = $"Node {node.Id}";
        Color stroke = node.Color ?? NodeStroke;
        Color fill = node.Color is Color color ? Color.Lerp(NodeFill, color, 0.12f) : NodeFill;
        ExcalidrawElement card = new ExcalidrawElement
        {
            Shape = ExcalidrawShape.Rectangle,
            Bounds = node.Bounds,
            WorldBounds = node.Bounds,
            Stroke = stroke,
            Fill = fill,
            StrokeWidth = 2f,
        };
        elements.Add(card);
        Rect inner = new Rect(node.Bounds.x + NodePadding, node.Bounds.y + NodePadding,
            Mathf.Max(0f, node.Bounds.width - 2f * NodePadding), Mathf.Max(0f, node.Bounds.height - 2f * NodePadding));
        switch (node.Type)
        {
            case "text":
                elements.Add(TextElement((string)node.Source["text"], inner, TextColor, NodeFontSize, TextAnchor.UpperLeft, true));
                break;
            case "link":
                card.Link = (string)node.Source["url"];
                elements.Add(TextElement(card.Link, inner, TextColor, NodeFontSize, TextAnchor.MiddleCenter, true));
                break;
            case "file":
                string path = ResolveFile((string)node.Source["file"], canvasPath, owner, dependsOn);
                string subpath = ReadString(node.Source, "subpath", owner, false);
                string name = Path.GetFileName(path) + subpath;
                if (ImageExtensions.Contains(Path.GetExtension(path).ToLowerInvariant()))
                {
                    elements.Add(new ExcalidrawElement
                    {
                        Shape = ExcalidrawShape.Image,
                        Text = name,
                        Bounds = inner,
                        WorldBounds = inner,
                        Stroke = TextColor,
                        FontSize = NodeFontSize,
                        Link = path,
                    });
                }
                else
                {
                    card.Link = path;
                    elements.Add(TextElement(name, inner, TextColor, NodeFontSize, TextAnchor.MiddleCenter, true));
                }

                break;
        }
    }

    private static void AddEdge(JObject edge, Dictionary<string, CanvasNode> nodes, List<ExcalidrawElement> paths, List<ExcalidrawElement> labels)
    {
        string id = ReadString(edge, "id", "An edge", true);
        string owner = $"Edge {id}";
        CanvasNode from = ReadEndNode(edge, "fromNode", nodes, owner);
        CanvasNode to = ReadEndNode(edge, "toNode", nodes, owner);
        string fromSide = ReadSide(edge, "fromSide", owner) ?? DefaultSide(from.Bounds.center, to.Bounds.center);
        string toSide = ReadSide(edge, "toSide", owner) ?? DefaultSide(to.Bounds.center, from.Bounds.center);
        Vector2 start = SidePoint(from.Bounds, fromSide);
        Vector2 end = SidePoint(to.Bounds, toSide);
        float reach = Mathf.Clamp(Vector2.Distance(start, end) / 2f, 30f, 150f);
        Vector2 startControl = start + SideNormal(fromSide) * reach;
        Vector2 endControl = end + SideNormal(toSide) * reach;
        Vector2[] points = Enumerable.Range(0, EdgeSamples + 1).Select(step => Bezier(start, startControl, endControl, end, step / (float)EdgeSamples)).ToArray();
        Color color = ReadColor(edge, owner) ?? EdgeColor;
        Rect bounds = Rect.MinMaxRect(points.Min(point => point.x), points.Min(point => point.y), points.Max(point => point.x), points.Max(point => point.y));
        paths.Add(new ExcalidrawElement
        {
            Shape = ExcalidrawShape.Arrow,
            Bounds = bounds,
            WorldBounds = bounds,
            Stroke = color,
            StrokeWidth = 2f,
            HasStartArrowhead = ReadEnd(edge, "fromEnd", "none", owner),
            HasEndArrowhead = ReadEnd(edge, "toEnd", "arrow", owner),
            Points = points,
        });

        string label = ReadString(edge, "label", owner, false);
        if (!string.IsNullOrEmpty(label))
        {
            Vector2 middle = Bezier(start, startControl, endControl, end, 0.5f);
            Vector2 size = new Vector2(label.Length * EdgeLabelFontSize * 0.6f + 2f * NodePadding, EdgeLabelFontSize + NodePadding);
            Rect labelBounds = new Rect(middle - size / 2f, size);
            labels.Add(new ExcalidrawElement
            {
                Shape = ExcalidrawShape.Rectangle,
                Bounds = labelBounds,
                WorldBounds = labelBounds,
                Stroke = Color.clear,
                Fill = Background,
                StrokeWidth = 1f,
            });
            labels.Add(TextElement(label, labelBounds, TextColor, EdgeLabelFontSize, TextAnchor.MiddleCenter, false));
        }
    }

    private static CanvasNode ReadEndNode(JObject edge, string name, Dictionary<string, CanvasNode> nodes, string owner)
    {
        string nodeId = ReadString(edge, name, owner, true);
        return nodes.TryGetValue(nodeId, out CanvasNode node) ? node
            : throw new InvalidDataException($"{owner}: \"{name}\" refers to the node {nodeId}, which does not exist.");
    }

    private static string ReadSide(JObject edge, string name, string owner)
    {
        string side = ReadString(edge, name, owner, false);
        return side == null || Sides.Contains(side) ? side
            : throw new InvalidDataException($"{owner}: \"{name}\" is \"{side}\", not top, right, bottom or left.");
    }

    private static bool ReadEnd(JObject edge, string name, string missingValue, string owner)
    {
        string end = ReadString(edge, name, owner, false) ?? missingValue;
        return end == "arrow" || (end == "none" ? false
            : throw new InvalidDataException($"{owner}: \"{name}\" is \"{end}\", not none or arrow."));
    }

    /// <summary>Side of the node at <paramref name="center"/> that faces <paramref name="other"/>.</summary>
    private static string DefaultSide(Vector2 center, Vector2 other)
    {
        Vector2 delta = other - center;
        return Mathf.Abs(delta.x) >= Mathf.Abs(delta.y) ? (delta.x >= 0f ? "right" : "left") : (delta.y >= 0f ? "bottom" : "top");
    }

    private static Vector2 SidePoint(Rect bounds, string side)
    {
        switch (side)
        {
            case "top": return new Vector2(bounds.center.x, bounds.yMin);
            case "bottom": return new Vector2(bounds.center.x, bounds.yMax);
            case "left": return new Vector2(bounds.xMin, bounds.center.y);
            default: return new Vector2(bounds.xMax, bounds.center.y);
        }
    }

    private static Vector2 SideNormal(string side)
    {
        switch (side)
        {
            case "top": return Vector2.down;
            case "bottom": return Vector2.up;
            case "left": return Vector2.left;
            default: return Vector2.right;
        }
    }

    private static Vector2 Bezier(Vector2 start, Vector2 startControl, Vector2 endControl, Vector2 end, float t)
    {
        float u = 1f - t;
        return u * u * u * start + 3f * u * u * t * startControl + 3f * u * t * t * endControl + t * t * t * end;
    }

    /// <summary>
    /// Finds <paramref name="file"/> relative to the canvas folder or one of its parent folders up to the logical root
    /// of the canvas (Assets or Packages/&lt;name&gt;). Rooted paths and paths that leave the root are not valid.
    /// The check reads the source file, because the linked asset can import after the canvas.
    /// </summary>
    private static string ResolveFile(string file, string canvasPath, string owner, System.Action<string> dependsOn)
    {
        string root = MarkdownInspector.LogicalRoot(canvasPath);
        if (root == null)
        {
            throw new InvalidDataException($"{owner}: the canvas is not under Assets or Packages/<name>.");
        }

        if (!MarkdownInspector.IsRelativeLink(file))
        {
            throw new InvalidDataException($"{owner}: the file path \"{file}\" must be relative to the vault.");
        }

        for (string folder = MarkdownInspector.ParentFolder(canvasPath); folder != null; folder = folder == root ? null : MarkdownInspector.ParentFolder(folder))
        {
            string candidate = MarkdownInspector.CombineInRoot(folder, file, root);
            if (candidate != null)
            {
                // Track every candidate, including missing files, so adding a nearer file reimports the canvas.
                dependsOn(candidate);
                if (File.Exists(MarkdownInspector.SourcePath(candidate)))
                {
                    return candidate;
                }
            }
        }

        throw new InvalidDataException($"{owner}: the file \"{file}\" does not exist in the canvas folder or a parent folder up to {root}.");
    }

    private static ExcalidrawElement TextElement(string text, Rect bounds, Color color, float fontSize, TextAnchor anchor, bool wrap) =>
        new ExcalidrawElement
        {
            Shape = ExcalidrawShape.Text,
            Text = text,
            Bounds = bounds,
            WorldBounds = bounds,
            Stroke = color,
            FontSize = fontSize,
            TextAnchor = anchor,
            WrapText = wrap,
        };

    private static string ReadString(JObject item, string name, string owner, bool required)
    {
        JToken token = item[name];
        if (token == null || token.Type == JTokenType.Null)
        {
            return required ? throw new InvalidDataException($"{owner}: \"{name}\" is missing.") : (string)null;
        }

        return token.Type == JTokenType.String ? (string)token : throw new InvalidDataException($"{owner}: \"{name}\" is not a string.");
    }

    private static float ReadNumber(JObject item, string name, string owner)
    {
        JToken token = item[name];
        if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
        {
            throw new InvalidDataException($"{owner}: \"{name}\" is missing or is not a number.");
        }

        float value = (float)token;
        return ExcalidrawImporter.IsFinite(value) ? value
            : throw new InvalidDataException($"{owner}: \"{name}\" must be a finite number.");
    }

    private static Color? ReadColor(JObject item, string owner)
    {
        string value = ReadString(item, "color", owner, false);
        if (value == null)
        {
            return null;
        }

        if (value.Length == 1 && value[0] >= '1' && value[0] <= '6')
        {
            return PresetColors[value[0] - '1'];
        }

        return value.StartsWith("#") && ColorUtility.TryParseHtmlString(value, out Color color) ? color
            : throw new InvalidDataException($"{owner}: the color \"{value}\" is not a hex color or a preset from 1 to 6.");
    }
}
