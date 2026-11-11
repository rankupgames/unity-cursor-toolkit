using System.Linq;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Pan, zoom and fit state for one view of an <see cref="ExcalidrawDrawing"/>, and the IMGUI drawing code.
/// Drag pans. Ctrl or Cmd with the scroll wheel zooms at the pointer; the plain scroll wheel stays with the Inspector.
/// A click on an element with a link selects the linked asset or opens the URL.
/// The view fits the drawing until the user pans or zooms, also when the canvas size changes.
/// Draws at Repaint only and culls off-screen elements.
/// </summary>
public sealed class ExcalidrawCanvas
{
    private const float MinimumZoom = 0.02f;
    private const float MaximumZoom = 8f;
    private const float SmallestReadableFontSize = 5f;
    private const float FitMargin = 24f;
    private const float ClickSlop = 4f;

    private static Font _monospaceFont;
    private static bool _monospaceFontLoaded;
    private static GUIStyle _textStyle;
    private static GUIStyle _wrappedTextStyle;

    private Vector2 _pan;
    private float _zoom = 1f;
    private bool _followFit = true;
    private Vector2 _fittedSize = new Vector2(float.NaN, float.NaN);
    private Vector2 _canvasSize;
    private Vector2 _pressPosition;
    private bool _invertLightness;

    /// <summary>Editor monospace font, or null when the editor does not ship it.</summary>
    public static Font MonospaceFont
    {
        get
        {
            if (!_monospaceFontLoaded)
            {
                _monospaceFont = EditorGUIUtility.Load("Fonts/RobotoMono/RobotoMono-Regular.ttf") as Font;
                _monospaceFontLoaded = true;
            }

            return _monospaceFont;
        }
    }

    public void RequestFit()
    {
        _followFit = true;
        _fittedSize = new Vector2(float.NaN, float.NaN);
    }

    /// <summary>Zooms by <paramref name="factor"/> at the center of the canvas.</summary>
    public void ZoomBy(float factor) => ZoomAt(_canvasSize / 2f, _zoom * factor);

    /// <summary>Handles input and draws the drawing in <paramref name="canvas"/>. Returns true when the view changed.</summary>
    public bool Draw(Rect canvas, ExcalidrawDrawing drawing)
    {
        int controlId = GUIUtility.GetControlID(FocusType.Passive);
        // Dark skin inverts lightness of drawings authored on a light background, as the Excalidraw dark mode does.
        _invertLightness = EditorGUIUtility.isProSkin && drawing.Background.grayscale > 0.5f;
        bool changed = HandleInput(canvas, controlId, drawing);
        if (Event.current.type != EventType.Repaint)
        {
            return changed;
        }

        _canvasSize = canvas.size;
        if (_followFit && _fittedSize != canvas.size)
        {
            FitToCanvas(canvas.size, drawing.ContentBounds);
        }

        EditorGUI.DrawRect(canvas, Themed(drawing.Background));
        GUI.BeginClip(canvas);
        DrawElements(new Rect(Vector2.zero, canvas.size), drawing);
        GUI.EndClip();
        return changed;
    }

    private void FitToCanvas(Vector2 canvasSize, Rect bounds)
    {
        _fittedSize = canvasSize;
        _zoom = Mathf.Clamp(Mathf.Min((canvasSize.x - FitMargin * 2f) / Mathf.Max(1f, bounds.width),
            (canvasSize.y - FitMargin * 2f) / Mathf.Max(1f, bounds.height)), MinimumZoom, MaximumZoom);
        _pan = canvasSize / 2f - bounds.center * _zoom;
    }

    private void ZoomAt(Vector2 pivot, float zoom)
    {
        zoom = Mathf.Clamp(zoom, MinimumZoom, MaximumZoom);
        _pan = pivot - (pivot - _pan) * (zoom / _zoom);
        _zoom = zoom;
        _followFit = false;
    }

    private bool HandleInput(Rect canvas, int controlId, ExcalidrawDrawing drawing)
    {
        Event current = Event.current;
        switch (current.GetTypeForControl(controlId))
        {
            case EventType.ScrollWheel when (current.control || current.command) && canvas.Contains(current.mousePosition):
                ZoomAt(current.mousePosition - canvas.position, _zoom * Mathf.Exp(-current.delta.y * 0.05f));
                current.Use();
                return true;
            case EventType.MouseDown when current.button == 0 && canvas.Contains(current.mousePosition):
                GUIUtility.hotControl = controlId;
                _pressPosition = current.mousePosition;
                current.Use();
                return false;
            case EventType.MouseDrag when GUIUtility.hotControl == controlId:
                _pan += current.delta;
                _followFit = false;
                current.Use();
                return true;
            case EventType.MouseUp when GUIUtility.hotControl == controlId:
                GUIUtility.hotControl = 0;
                current.Use();
                if ((current.mousePosition - _pressPosition).sqrMagnitude <= ClickSlop * ClickSlop)
                {
                    OpenLinkAt(current.mousePosition - canvas.position, drawing);
                }

                return false;
            default:
                return false;
        }
    }

    private void OpenLinkAt(Vector2 canvasPoint, ExcalidrawDrawing drawing)
    {
        // The last drawn element is on top.
        for (int index = drawing.Elements.Count - 1; index >= 0; index--)
        {
            ExcalidrawElement element = drawing.Elements[index];
            if (string.IsNullOrEmpty(element.Link) || !ToScreen(element.WorldBounds).Contains(canvasPoint))
            {
                continue;
            }

            if (IsWebLink(element.Link))
            {
                Application.OpenURL(element.Link);
                return;
            }

            Object asset = AssetDatabase.LoadMainAssetAtPath(element.Link);
            if (asset == null)
            {
                Debug.LogError($"The linked asset {element.Link} does not exist or is not imported.");
                return;
            }

            Selection.activeObject = asset;
            EditorGUIUtility.PingObject(asset);
            return;
        }
    }

    private static bool IsWebLink(string link) =>
        link.StartsWith("https://", System.StringComparison.OrdinalIgnoreCase) || link.StartsWith("http://", System.StringComparison.OrdinalIgnoreCase);

    private Rect ToScreen(Rect world) => new Rect(world.position * _zoom + _pan, world.size * _zoom);

    private void DrawElements(Rect view, ExcalidrawDrawing drawing)
    {
        _textStyle = _textStyle ?? new GUIStyle(EditorStyles.label) { wordWrap = false, clipping = TextClipping.Clip, richText = false, padding = new RectOffset() };
        _wrappedTextStyle = _wrappedTextStyle ?? new GUIStyle(_textStyle) { wordWrap = true, clipping = TextClipping.Clip };
        Rect cullRect = new Rect(view.x - 8f, view.y - 24f, view.width + 16f, view.height + 48f);
        foreach (ExcalidrawElement element in drawing.Elements)
        {
            Rect screen = ToScreen(element.WorldBounds);
            if (!screen.Overlaps(cullRect))
            {
                continue;
            }

            if (!string.IsNullOrEmpty(element.Link))
            {
                EditorGUIUtility.AddCursorRect(Rect.MinMaxRect(Mathf.Max(screen.xMin, view.xMin), Mathf.Max(screen.yMin, view.yMin),
                    Mathf.Min(screen.xMax, view.xMax), Mathf.Min(screen.yMax, view.yMax)), MouseCursor.Link);
            }

            Handles.color = Themed(element.Stroke);
            float strokeWidth = Mathf.Max(1f, element.StrokeWidth * _zoom);
            switch (element.Shape)
            {
                case ExcalidrawShape.Rectangle:
                    DrawPolygon(element, strokeWidth, Corners(screen));
                    break;
                case ExcalidrawShape.Diamond:
                    DrawPolygon(element, strokeWidth, new Vector3[]
                    {
                        new Vector2(screen.center.x, screen.yMin), new Vector2(screen.xMax, screen.center.y),
                        new Vector2(screen.center.x, screen.yMax), new Vector2(screen.xMin, screen.center.y),
                    });
                    break;
                case ExcalidrawShape.Ellipse:
                    DrawPolygon(element, strokeWidth, Enumerable.Range(0, 48).Select(step =>
                    {
                        float angle = step * Mathf.PI * 2f / 48f;
                        return (Vector3)(screen.center + new Vector2(Mathf.Cos(angle) * screen.width, Mathf.Sin(angle) * screen.height) / 2f);
                    }).ToArray());
                    break;
                case ExcalidrawShape.Frame:
                    Handles.DrawAAPolyLine(1f, Closed(Corners(screen)));
                    DrawText(element, new Rect(screen.x, screen.y - 14f * _zoom - 6f, screen.width, 14f * _zoom + 4f), 14f, TextAnchor.LowerLeft);
                    break;
                case ExcalidrawShape.Text:
                    DrawText(element, screen, element.FontSize, element.TextAnchor);
                    break;
                case ExcalidrawShape.Image:
                    DrawImage(element, screen);
                    break;
                case ExcalidrawShape.Line:
                case ExcalidrawShape.Arrow:
                case ExcalidrawShape.Freedraw:
                    DrawPath(element, strokeWidth);
                    break;
            }
        }
    }

    private void DrawImage(ExcalidrawElement element, Rect screen)
    {
        Texture texture = AssetDatabase.LoadAssetAtPath<Texture>(element.Link);
        if (texture != null)
        {
            GUI.DrawTexture(screen, texture, ScaleMode.ScaleToFit);
            return;
        }

        // The file is not imported as a texture: show an outline and its name. Image strokes are often transparent.
        Color outline = Themed(new Color(0.5f, 0.5f, 0.5f));
        EditorGUI.DrawRect(new Rect(screen.x, screen.y, screen.width, 1f), outline);
        EditorGUI.DrawRect(new Rect(screen.x, screen.yMax - 1f, screen.width, 1f), outline);
        EditorGUI.DrawRect(new Rect(screen.x, screen.y, 1f, screen.height), outline);
        EditorGUI.DrawRect(new Rect(screen.xMax - 1f, screen.y, 1f, screen.height), outline);
        DrawText(element, screen, element.FontSize, TextAnchor.MiddleCenter, outline);
    }

    private void DrawPolygon(ExcalidrawElement element, float strokeWidth, Vector3[] corners)
    {
        if (element.Fill.a > 0f)
        {
            Color stroke = Handles.color;
            Handles.color = Themed(element.Fill);
            Handles.DrawAAConvexPolygon(corners);
            Handles.color = stroke;
        }

        DrawStroke(element, strokeWidth, Closed(corners));
    }

    private static void DrawStroke(ExcalidrawElement element, float strokeWidth, Vector3[] points)
    {
        if (!element.Dashed)
        {
            Handles.DrawAAPolyLine(strokeWidth, points);
            return;
        }

        // Dashes are separate anti-aliased segments, so that they keep the stroke width and the canvas clip.
        float dash = Mathf.Max(6f, strokeWidth * 4f);
        float gap = dash * 0.75f;
        var segment = new Vector3[2];
        for (int index = 1; index < points.Length; index++)
        {
            Vector3 start = points[index - 1];
            Vector3 direction = points[index] - start;
            float length = direction.magnitude;
            if (length <= 0f)
            {
                continue;
            }

            // At high zoom, longer dashes keep the count per segment small.
            float scale = Mathf.Max(1f, length / ((dash + gap) * 512f));
            direction /= length;
            for (float offset = 0f; offset < length; offset += (dash + gap) * scale)
            {
                segment[0] = start + direction * offset;
                segment[1] = start + direction * Mathf.Min(offset + dash * scale, length);
                Handles.DrawAAPolyLine(strokeWidth, segment);
            }
        }
    }

    private void DrawPath(ExcalidrawElement element, float strokeWidth)
    {
        if (element.Points == null || element.Points.Length < 2)
        {
            return;
        }

        Vector3[] points = element.Points.Select(point => (Vector3)(point * _zoom + _pan)).ToArray();
        DrawStroke(element, strokeWidth, points);
        if (element.HasEndArrowhead)
        {
            DrawArrowhead(points[points.Length - 1], points[points.Length - 2], strokeWidth);
        }

        if (element.HasStartArrowhead)
        {
            DrawArrowhead(points[0], points[1], strokeWidth);
        }
    }

    private void DrawArrowhead(Vector2 tip, Vector2 previous, float strokeWidth)
    {
        Vector2 back = (previous - tip).normalized * Mathf.Max(6f, 14f * _zoom);
        Vector2 side = new Vector2(-back.y, back.x) * 0.4f;
        Handles.DrawAAPolyLine(strokeWidth, tip + back + side, tip, tip + back - side);
    }

    private void DrawText(ExcalidrawElement element, Rect screen, float fontSize, TextAnchor anchor, Color? color = null)
    {
        float size = fontSize * _zoom;
        if (string.IsNullOrEmpty(element.Text) || size < SmallestReadableFontSize)
        {
            return;
        }

        GUIStyle style = element.WrapText ? _wrappedTextStyle : _textStyle;
        style.font = element.Monospace && MonospaceFont != null ? MonospaceFont : EditorStyles.label.font;
        style.fontSize = Mathf.RoundToInt(size);
        style.alignment = anchor;
        style.normal.textColor = color ?? Themed(element.Stroke);
        GUI.Label(screen, element.Text, style);
    }

    private static Vector3[] Corners(Rect rect) => new Vector3[]
    {
        new Vector2(rect.xMin, rect.yMin), new Vector2(rect.xMax, rect.yMin),
        new Vector2(rect.xMax, rect.yMax), new Vector2(rect.xMin, rect.yMax),
    };

    private static Vector3[] Closed(Vector3[] corners) => corners.Append(corners[0]).ToArray();

    /// <summary>Inverts lightness and keeps hue.</summary>
    private Color Themed(Color color)
    {
        if (!_invertLightness)
        {
            return color;
        }

        float shift = 1f - Mathf.Max(color.r, color.g, color.b) - Mathf.Min(color.r, color.g, color.b);
        return new Color(color.r + shift, color.g + shift, color.b + shift, color.a);
    }
}
