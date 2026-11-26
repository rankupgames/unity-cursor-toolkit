using UnityEditor;
#if UNITY_2020_2_OR_NEWER
using UnityEditor.AssetImporters;
#else
using UnityEditor.Experimental.AssetImporters;
#endif
using UnityEngine;

/// <summary>
/// Shows a .excalidraw or Obsidian .canvas asset as one canvas that fills the Inspector. The importers have no settings to show.
/// </summary>
[CustomEditor(typeof(ExcalidrawImporter))]
public class ExcalidrawImporterEditor : ScriptedImporterEditor
{
    private const float ButtonHeight = 18f;
    private const float ButtonGap = 2f;
    private const float ButtonInset = 4f;
    private const float ZoomStep = 1.25f;

    private static GUIContent _zoomOutLabel;
    private static GUIContent _zoomInLabel;
    private static readonly GUIContent FitLabel = new GUIContent("Fit", "Fit the drawing to the view");

    private readonly ExcalidrawCanvas _canvas = new ExcalidrawCanvas();
    private readonly InspectorHost _host = new InspectorHost();

    protected override bool needsApplyRevert => false;

    public override bool showImportedObject => false;

    public override void OnInspectorGUI()
    {
        if (assetTarget is ExcalidrawDrawing drawing)
        {
            DrawFullCanvas(_canvas, drawing, _host, this);
        }
    }

    /// <summary>Draws <paramref name="drawing"/> from the current layout position to the bottom of the Inspector.</summary>
    public static void DrawFullCanvas(ExcalidrawCanvas canvas, ExcalidrawDrawing drawing, InspectorHost host, Editor editor)
    {
        string status = StatusMessage(drawing, out MessageType statusType);
        if (status != null)
        {
            EditorGUILayout.HelpBox(status, statusType);
            return;
        }

        if (host.Diagnostic != null)
        {
            EditorGUILayout.HelpBox(host.Diagnostic, MessageType.Warning);
        }

        // The Inspector disables GUI for imported assets; the canvas stays interactive.
        bool wasEnabled = GUI.enabled;
        GUI.enabled = true;
        Rect canvasRect = GUILayoutUtility.GetRect(0f, host.FillHeight, GUILayout.ExpandWidth(true));
        Event current = Event.current;
        if (current.type == EventType.Repaint)
        {
            host.Locate(canvasRect);
            if (host.UpdateFill())
            {
                editor.Repaint();
            }
        }

        _zoomOutLabel = _zoomOutLabel ?? EditorGUIUtility.IconContent("Toolbar Minus", "|Zoom out");
        _zoomInLabel = _zoomInLabel ?? EditorGUIUtility.IconContent("Toolbar Plus", "|Zoom in");
        Rect fitRect = new Rect(canvasRect.xMax - ButtonInset - 36f, canvasRect.y + ButtonInset, 36f, ButtonHeight);
        Rect zoomInRect = new Rect(fitRect.x - ButtonGap - 24f, fitRect.y, 24f, ButtonHeight);
        Rect zoomOutRect = new Rect(zoomInRect.x - ButtonGap - 24f, fitRect.y, 24f, ButtonHeight);

        // The buttons lie on the canvas: they take their clicks before the canvas and paint after it.
        if (current.type == EventType.MouseDown && current.button == 0)
        {
            bool clicked = true;
            if (fitRect.Contains(current.mousePosition))
            {
                canvas.RequestFit();
            }
            else if (zoomInRect.Contains(current.mousePosition))
            {
                canvas.ZoomBy(ZoomStep);
            }
            else if (zoomOutRect.Contains(current.mousePosition))
            {
                canvas.ZoomBy(1f / ZoomStep);
            }
            else
            {
                clicked = false;
            }

            if (clicked)
            {
                current.Use();
                editor.Repaint();
            }
        }

        if (canvas.Draw(canvasRect, drawing))
        {
            editor.Repaint();
        }

        DrawButton(zoomOutRect, _zoomOutLabel, current);
        DrawButton(zoomInRect, _zoomInLabel, current);
        DrawButton(fitRect, FitLabel, current);
        GUI.enabled = wasEnabled;
    }

    private static void DrawButton(Rect rect, GUIContent content, Event current)
    {
        if (current.type == EventType.Repaint)
        {
            EditorStyles.miniButton.Draw(rect, content, rect.Contains(current.mousePosition), false, false, false);
        }

        // Registers the tooltip.
        GUI.Label(rect, new GUIContent(string.Empty, content.tooltip), GUIStyle.none);
    }

    /// <summary>Returns the import error or empty-drawing message, or null when the drawing can be shown.</summary>
    public static string StatusMessage(ExcalidrawDrawing drawing, out MessageType type)
    {
        if (!string.IsNullOrEmpty(drawing.ImportError))
        {
            type = MessageType.Error;
            return drawing.ImportError;
        }

        type = drawing.Elements.Count == 0 ? MessageType.Warning : MessageType.None;
        return drawing.Elements.Count == 0 ? "The drawing has no supported elements." : null;
    }
}

[CustomEditor(typeof(ObsidianCanvasImporter))]
public sealed class ObsidianCanvasImporterEditor : ExcalidrawImporterEditor
{
}
