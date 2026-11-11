using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
#if UNITY_2020_2_OR_NEWER
using UnityEditor.AssetImporters;
#else
using UnityEditor.Experimental.AssetImporters;
#endif
using UnityEngine;

/// <summary>
/// Imports native .excalidraw documents as <see cref="ExcalidrawDrawing"/> assets.
/// Rotation, hand-drawn roughness and embeddables are not imported. Obsidian resolves image assets through its file map.
/// </summary>
[ScriptedImporter(4, "excalidraw")]
public sealed class ExcalidrawImporter : ScriptedImporter
{
    private const string IconFileName = "ExcalidrawIcon.png";

    public override void OnImportAsset(AssetImportContext ctx) => Import(ctx, Parse);

    /// <summary>Adds the drawing that <paramref name="parse"/> makes from the source file, or a drawing that shows its error.</summary>
    internal static void Import(AssetImportContext ctx, System.Action<string, ExcalidrawDrawing> parse)
    {
        ExcalidrawDrawing drawing = ScriptableObject.CreateInstance<ExcalidrawDrawing>();
        try
        {
            parse(File.ReadAllText(MarkdownInspector.SourcePath(ctx.assetPath)), drawing);
        }
        catch (System.Exception exception) when (exception is Newtonsoft.Json.JsonException || exception is IOException
            || exception is System.UnauthorizedAccessException || exception is System.ArgumentException)
        {
            drawing.Elements.Clear();
            drawing.ContentBounds = default(Rect);
            drawing.ImportError = exception.Message;
            ctx.LogImportError($"{ctx.assetPath}: {exception.Message}", drawing);
        }

        // The icon lies next to the drawing script, so the folder can move. The script path is an Assets/ or Packages/ path.
        string scriptPath = AssetDatabase.GetAssetPath(MonoScript.FromScriptableObject(drawing));
        Texture2D icon = null;
        if (!string.IsNullOrEmpty(scriptPath))
        {
            string iconPath = $"{Path.GetDirectoryName(scriptPath).Replace('\\', '/')}/{IconFileName}";
#if UNITY_2020_1_OR_NEWER
            ctx.DependsOnArtifact(iconPath);
#else
            ctx.DependsOnSourceAsset(iconPath);
#endif
            icon = AssetDatabase.LoadAssetAtPath<Texture2D>(iconPath);
        }

        ctx.AddObjectToAsset("drawing", drawing, icon);
        ctx.SetMainObject(drawing);
    }

    /// <summary>Fills <paramref name="drawing"/> from native Excalidraw JSON. Throws JsonException or InvalidDataException.</summary>
    internal static void Parse(string source, ExcalidrawDrawing drawing)
        => Parse(source, drawing, null);

    internal static void Parse(string source, ExcalidrawDrawing drawing, System.Func<string, string> resolveImage)
    {
        JObject document = JObject.Parse(source, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
        if (ReadString(document, "type", "The document") != "excalidraw" || !(document["elements"] is JArray elements))
        {
            throw new InvalidDataException("The file is not a native Excalidraw document.");
        }

        JToken appState = document["appState"];
        if (appState != null && appState.Type != JTokenType.Null && !(appState is JObject))
        {
            throw new InvalidDataException("\"appState\" is not a JSON object.");
        }

        drawing.Background = ParseColor(appState?["viewBackgroundColor"], Color.white, "appState");
        var elementIds = new HashSet<string>();
        foreach (JToken element in elements)
        {
            if (!(element is JObject elementObject))
            {
                throw new InvalidDataException("An element is not a JSON object.");
            }

            string elementId = ReadString(elementObject, "id", "An element");
            if (string.IsNullOrWhiteSpace(elementId))
            {
                throw new InvalidDataException("An element id is missing or empty.");
            }

            if (!elementIds.Add(elementId))
            {
                throw new InvalidDataException($"Element {elementId}: the id is not unique.");
            }

            string owner = $"Element {elementId ?? "(no id)"}";
            string elementType = ReadString(elementObject, "type", owner);
            if (string.IsNullOrWhiteSpace(elementType))
            {
                throw new InvalidDataException($"{owner}: the type is missing or empty.");
            }

            if (ReadBool(elementObject, "isDeleted", owner) || !TryParseShape(elementType, out ExcalidrawShape shape))
            {
                continue;
            }

            ExcalidrawElement parsed = ParseElement(elementObject, shape, owner);
            if (shape == ExcalidrawShape.Image)
            {
                string fileId = ReadString(elementObject, "fileId", owner);
                parsed.Link = string.IsNullOrEmpty(fileId) ? null : resolveImage?.Invoke(fileId);
                if (string.IsNullOrEmpty(parsed.Link))
                {
                    throw new InvalidDataException($"Image {fileId ?? "(no file id)"}: no image asset could be resolved.");
                }

                parsed.Text = Path.GetFileName(parsed.Link);
            }

            drawing.Elements.Add(parsed);
        }

        UpdateContentBounds(drawing);
    }

    /// <summary>Sets <see cref="ExcalidrawDrawing.ContentBounds"/> to the union of the element bounds.</summary>
    internal static void UpdateContentBounds(ExcalidrawDrawing drawing)
    {
        if (drawing.Elements.Count == 0)
        {
            return;
        }

        Rect bounds = drawing.Elements[0].WorldBounds;
        foreach (ExcalidrawElement element in drawing.Elements)
        {
            bounds = Rect.MinMaxRect(Mathf.Min(bounds.xMin, element.WorldBounds.xMin), Mathf.Min(bounds.yMin, element.WorldBounds.yMin),
                Mathf.Max(bounds.xMax, element.WorldBounds.xMax), Mathf.Max(bounds.yMax, element.WorldBounds.yMax));
        }

        if (!IsFinite(bounds.xMin) || !IsFinite(bounds.yMin) || !IsFinite(bounds.xMax) || !IsFinite(bounds.yMax)
            || !IsFinite(bounds.width) || !IsFinite(bounds.height))
        {
            throw new InvalidDataException("The drawing bounds are not finite.");
        }

        drawing.ContentBounds = bounds;
    }

    internal static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);

    private static bool TryParseShape(string type, out ExcalidrawShape shape)
    {
        switch (type)
        {
            case "rectangle": shape = ExcalidrawShape.Rectangle; return true;
            case "diamond": shape = ExcalidrawShape.Diamond; return true;
            case "ellipse": shape = ExcalidrawShape.Ellipse; return true;
            case "frame": shape = ExcalidrawShape.Frame; return true;
            case "text": shape = ExcalidrawShape.Text; return true;
            case "line": shape = ExcalidrawShape.Line; return true;
            case "arrow": shape = ExcalidrawShape.Arrow; return true;
            case "freedraw": shape = ExcalidrawShape.Freedraw; return true;
            case "image": shape = ExcalidrawShape.Image; return true;
            default: shape = default(ExcalidrawShape); return false;
        }
    }

    private static ExcalidrawElement ParseElement(JObject element, ExcalidrawShape shape, string owner)
    {
        foreach (string name in new[] { "x", "y", "width", "height" })
        {
            if (element[name] == null || element[name].Type == JTokenType.Null)
            {
                throw new InvalidDataException($"{owner}: \"{name}\" is missing.");
            }
        }

        float alpha = ReadNumber(element, "opacity", 100f, owner) / 100f;
        Color stroke = ParseColor(element["strokeColor"], Color.black, owner);
        Color fill = ParseColor(element["backgroundColor"], Color.clear, owner);
        stroke.a *= alpha;
        fill.a *= alpha;
        Vector2 origin = new Vector2(ReadNumber(element, "x", 0f, owner), ReadNumber(element, "y", 0f, owner));
        float width = ReadNumber(element, "width", 0f, owner);
        float height = ReadNumber(element, "height", 0f, owner);
        if (width < 0f || height < 0f)
        {
            throw new InvalidDataException($"{owner}: the width or height is negative.");
        }

        bool middle = ReadString(element, "verticalAlign", owner) == "middle";
        string horizontal = ReadString(element, "textAlign", owner);
        string strokeStyle = ReadString(element, "strokeStyle", owner);
        Rect bounds = new Rect(origin.x, origin.y, width, height);
        Vector2[] points = ReadPoints(element["points"], origin, owner);
        return new ExcalidrawElement
        {
            Shape = shape,
            Text = ReadString(element, shape == ExcalidrawShape.Frame ? "name" : "text", owner),
            Bounds = bounds,
            WorldBounds = points == null || points.Length == 0 ? bounds
                : Rect.MinMaxRect(points.Min(point => point.x), points.Min(point => point.y), points.Max(point => point.x), points.Max(point => point.y)),
            Stroke = stroke,
            Fill = fill,
            StrokeWidth = ReadNumber(element, "strokeWidth", 1f, owner),
            Dashed = strokeStyle == "dashed" || strokeStyle == "dotted",
            FontSize = ReadNumber(element, "fontSize", 20f, owner),
            Monospace = element["fontFamily"]?.Type == JTokenType.Integer && (long)element["fontFamily"] == 3,
            HasStartArrowhead = element["startArrowhead"]?.Type == JTokenType.String,
            HasEndArrowhead = element["endArrowhead"]?.Type == JTokenType.String,
            TextAnchor = horizontal == "center" ? (middle ? TextAnchor.MiddleCenter : TextAnchor.UpperCenter)
                : horizontal == "right" ? (middle ? TextAnchor.MiddleRight : TextAnchor.UpperRight)
                : middle ? TextAnchor.MiddleLeft : TextAnchor.UpperLeft,
            Points = points,
        };
    }

    /// <summary>Returns null for a missing or null value. Throws when the value is not a string.</summary>
    private static string ReadString(JObject item, string name, string owner)
    {
        JToken token = item[name];
        if (token == null || token.Type == JTokenType.Null)
        {
            return null;
        }

        if (token.Type != JTokenType.String)
        {
            throw new InvalidDataException($"{owner}: \"{name}\" is not a string.");
        }

        return (string)token;
    }

    private static bool ReadBool(JObject item, string name, string owner)
    {
        JToken token = item[name];
        if (token == null || token.Type == JTokenType.Null)
        {
            return false;
        }

        if (token.Type != JTokenType.Boolean)
        {
            throw new InvalidDataException($"{owner}: \"{name}\" is not true or false.");
        }

        return (bool)token;
    }

    private static float ReadNumber(JObject element, string name, float missingValue, string owner)
    {
        JToken token = element[name];
        if (token == null || token.Type == JTokenType.Null)
        {
            return missingValue;
        }

        return ToFiniteFloat(token, $"{owner}: \"{name}\"");
    }

    /// <summary>Converts a JSON number to a finite float. A value outside the float range is not finite.</summary>
    internal static float ToFiniteFloat(JToken token, string description)
    {
        if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
        {
            throw new InvalidDataException($"{description} is not a number.");
        }

        float value = (float)token;
        if (!IsFinite(value))
        {
            throw new InvalidDataException($"{description} is not a finite number.");
        }

        return value;
    }

    private static Vector2[] ReadPoints(JToken token, Vector2 origin, string owner)
    {
        if (token == null || token.Type == JTokenType.Null)
        {
            return null;
        }

        if (!(token is JArray points))
        {
            throw new InvalidDataException($"{owner}: \"points\" is not an array.");
        }

        return points.Select(point =>
        {
            if (!(point is JArray pair) || pair.Count < 2)
            {
                throw new InvalidDataException($"{owner}: a point is not a pair of numbers.");
            }

            var position = origin + new Vector2(ToFiniteFloat(pair[0], $"{owner}: a point"), ToFiniteFloat(pair[1], $"{owner}: a point"));
            if (!IsFinite(position.x) || !IsFinite(position.y))
            {
                throw new InvalidDataException($"{owner}: a point is not finite.");
            }

            return position;
        }).ToArray();
    }

    /// <summary>Returns <paramref name="missingValue"/> for a missing or empty color. Throws for a color that is not valid.</summary>
    internal static Color ParseColor(JToken token, Color missingValue, string owner)
    {
        if (token == null || token.Type == JTokenType.Null)
        {
            return missingValue;
        }

        if (token.Type != JTokenType.String)
        {
            throw new InvalidDataException($"{owner}: a color is not a string.");
        }

        string value = (string)token;
        if (value.Length == 0)
        {
            return missingValue;
        }

        if (value == "transparent")
        {
            return Color.clear;
        }

        Color color;
        if (!ColorUtility.TryParseHtmlString(value, out color))
        {
            throw new InvalidDataException($"{owner}: the color \"{value}\" is not valid.");
        }

        return color;
    }
}
