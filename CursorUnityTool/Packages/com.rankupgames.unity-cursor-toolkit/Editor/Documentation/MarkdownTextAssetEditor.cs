using UnityEditor;
using UnityEngine;

/// <summary>
/// A single .md file shows its formatted Markdown or Obsidian drawing once. Other text assets and multiple selections
/// delegate to Unity's native TextAsset inspector.
/// </summary>
[CustomEditor(typeof(TextAsset))]
[CanEditMultipleObjects]
public sealed class MarkdownTextAssetEditor : Editor
{
    // Unity's internal inspector. Null when this Unity version does not have it; the editor then shows a diagnostic.
    private static readonly System.Type NativeInspectorType = typeof(Editor).Assembly.GetType("UnityEditor.TextAssetInspector", false);
    // One view per editor, so that each Inspector (also a locked one) has its own layout and canvas.
    private MarkdownInspector.MarkdownView _view;
    private Editor _nativeInspector;

    private string MarkdownPath
    {
        get
        {
            string path = targets.Length == 1 ? AssetDatabase.GetAssetPath(target) : null;
            return MarkdownInspector.IsMarkdownPath(path) ? path : null;
        }
    }

    private void OnEnable()
    {
        // A reimport or a new asset can change the text and the targets of links and embeds.
        EditorApplication.projectChanged += OnProjectChanged;
    }

    private void OnDisable()
    {
        EditorApplication.projectChanged -= OnProjectChanged;
        ResetView();
    }

    protected override void OnHeaderGUI()
    {
        if (MarkdownPath == null)
        {
            base.OnHeaderGUI();
        }
    }

    public override void OnInspectorGUI()
    {
        string path = MarkdownPath;
        if (path == null)
        {
            if (NativeInspectorType == null)
            {
                EditorGUILayout.HelpBox("UnityEditor.TextAssetInspector does not exist in this Unity version, so the native TextAsset Inspector cannot be shown. "
                    + "Remove UCT_DOCUMENTATION from the Scripting Define Symbols to restore it.", MessageType.Error);
                return;
            }

            if (_nativeInspector == null)
            {
                _nativeInspector = CreateEditor(targets, NativeInspectorType);
            }

            if (_nativeInspector == null)
            {
                EditorGUILayout.HelpBox("Unity could not create its native TextAsset Inspector. Remove UCT_DOCUMENTATION to restore the default Inspector.", MessageType.Error);
                return;
            }

            _nativeInspector.OnInspectorGUI();
            return;
        }

        _view = _view ?? new MarkdownInspector.MarkdownView(path);
        _view.OnGUI(this);
    }

    private void OnProjectChanged()
    {
        ResetView();
        Repaint();
    }

    private void ResetView()
    {
        _view?.Dispose();
        _view = null;
        if (_nativeInspector != null)
        {
            DestroyImmediate(_nativeInspector);
            _nativeInspector = null;
        }
    }
}
