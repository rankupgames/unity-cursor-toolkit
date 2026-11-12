using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

/// <summary>
/// Finds the window and scroll view that show an IMGUI editor, so the editor can fill the free Inspector height
/// without a scroll bar and skip content that is not in view. Each Inspector, also a locked one, needs its own instance.
/// </summary>
public sealed class InspectorHost
{
    private const float MinimumFillHeight = 120f;
    // Repaints to wait for the scroll view layout after a height change, before measuring again.
    private const int MaximumLayoutWaits = 3;
    private static readonly Rect Everything = new Rect(-1e6f, -1e6f, 2e6f, 2e6f);

    private EditorWindow _window;
    private ScrollView _scrollView;
    private float _contentHeightAtChange = float.NaN;
    private int _layoutWaits;
    private int _locateAttempts;

    public string Diagnostic { get; private set; }

    /// <summary>Height that makes the Inspector content end at the bottom of the scroll view.</summary>
    public float FillHeight { get; private set; } = 240f;

    /// <summary>Window area in GUI coordinates, or all space when the window is not found. Call during OnGUI.</summary>
    public Rect VisibleRect => _window == null ? Everything
        : new Rect(GUIUtility.ScreenToGUIPoint(_window.position.position), _window.position.size);

    /// <summary>Finds the window and the innermost scroll view that show <paramref name="guiRect"/>. Call at Repaint.</summary>
    public void Locate(Rect guiRect)
    {
        Vector2 point = GUIUtility.GUIToScreenPoint(new Vector2(guiRect.center.x, guiRect.y + 1f));
        if (_window != null && _scrollView?.panel != null && _window.position.Contains(point) && ViewportContains(_window, _scrollView, point))
        {
            return;
        }

        _window = null;
        _scrollView = null;
        if (_locateAttempts++ >= MaximumLayoutWaits)
        {
            Diagnostic = "The Inspector scroll view could not be located. Automatic height and window culling are unavailable. Reopen the Inspector to retry.";
            return;
        }

        foreach (EditorWindow window in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (window.rootVisualElement.panel == null || !window.position.Contains(point))
            {
                continue;
            }

            // Query order is depth first, so the last match is the innermost scroll view.
            ScrollView found = null;
            window.rootVisualElement.Query<ScrollView>().ForEach(scrollView =>
            {
                if (ViewportContains(window, scrollView, point))
                {
                    found = scrollView;
                }
            });

            if (found != null)
            {
                _window = window;
                _scrollView = found;
                _locateAttempts = 0;
                Diagnostic = null;
                return;
            }
        }
    }

    private static bool ViewportContains(EditorWindow window, ScrollView scrollView, Vector2 screenPoint)
    {
        Vector2 panelPoint = screenPoint - window.position.position + window.rootVisualElement.worldBound.position;
        return scrollView.contentViewport.worldBound.Contains(panelPoint);
    }

    /// <summary>Updates <see cref="FillHeight"/> from the scroll view layout. Returns true when the caller must repaint.</summary>
    public bool UpdateFill()
    {
        if (_scrollView == null)
        {
            return false;
        }

        float viewportHeight = _scrollView.contentViewport.layout.height;
        float contentHeight = NaturalContentHeight(_scrollView.contentContainer);
        if (float.IsNaN(viewportHeight) || float.IsNaN(contentHeight))
        {
            return false;
        }

        // After a change, the scroll view has the old content height until its next layout.
        if (Mathf.Approximately(contentHeight, _contentHeightAtChange) && _layoutWaits++ < MaximumLayoutWaits)
        {
            return true;
        }

        _contentHeightAtChange = float.NaN;
        _layoutWaits = 0;
        float height = Mathf.Max(MinimumFillHeight, Mathf.Floor(viewportHeight - (contentHeight - FillHeight)));
        if (Mathf.Abs(height - FillHeight) < 1f)
        {
            return false;
        }

        FillHeight = height;
        _contentHeightAtChange = contentHeight;
        return true;
    }

    /// <summary>Height of the content itself; the content container can be stretched to the viewport height.</summary>
    private static float NaturalContentHeight(VisualElement contentContainer)
    {
        float bottom = 0f;
        foreach (VisualElement child in contentContainer.Children())
        {
            if (child.resolvedStyle.display != DisplayStyle.None && child.resolvedStyle.position != Position.Absolute)
            {
                bottom = Mathf.Max(bottom, child.layout.yMax + child.resolvedStyle.marginBottom);
            }
        }

        return bottom > 0f ? bottom + contentContainer.resolvedStyle.paddingBottom : contentContainer.layout.height;
    }
}
