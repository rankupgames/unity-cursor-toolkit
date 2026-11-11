using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>Imported main object of a native .excalidraw file or an Obsidian .canvas file.</summary>
public sealed class ExcalidrawDrawing : ScriptableObject
{
    public Color Background = Color.white;
    public Rect ContentBounds;
    public List<ExcalidrawElement> Elements = new List<ExcalidrawElement>();
    /// <summary>Set when the source file is not a valid document or refers to a missing file.</summary>
    public string ImportError;
}

public enum ExcalidrawShape
{
    Rectangle,
    Diamond,
    Ellipse,
    Frame,
    Text,
    Line,
    Arrow,
    Freedraw,
    /// <summary>Texture asset at <see cref="ExcalidrawElement.Link"/>, scaled to fit the bounds.</summary>
    Image,
}

[Serializable]
public sealed class ExcalidrawElement
{
    public ExcalidrawShape Shape;
    public string Text;
    public Rect Bounds;
    /// <summary>Bounds that include path points; used for fit and culling.</summary>
    public Rect WorldBounds;
    public Color Stroke;
    public Color Fill;
    public float StrokeWidth;
    public bool Dashed;
    public float FontSize;
    public bool Monospace;
    public bool HasStartArrowhead;
    public bool HasEndArrowhead;
    public TextAnchor TextAnchor;
    /// <summary>Text wraps inside <see cref="Bounds"/> and is clipped to it.</summary>
    public bool WrapText;
    /// <summary>Asset path or http(s) URL that a click on the element opens.</summary>
    public string Link;
    /// <summary>Absolute path points in drawing space.</summary>
    public Vector2[] Points;
}
