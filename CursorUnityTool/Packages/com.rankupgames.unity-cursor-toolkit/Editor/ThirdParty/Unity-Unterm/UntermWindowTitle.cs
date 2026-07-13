using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>Creates EditorWindow titles without dropping their tab icons on live title changes.</summary>
    internal static class UntermWindowTitle
    {
        internal const string TerminalIcon = "UnityEditor.ConsoleWindow";
        internal const string AgentIcon = "UnityEditor.ConsoleWindow";
        internal const string CodeEditorIcon = "cs Script Icon";

        private static readonly Dictionary<string, Texture> Icons = new();

        internal static GUIContent Create(string text, string iconName, GUIContent current = null)
        {
            Texture icon = current?.image;
            if (icon == null && !string.IsNullOrEmpty(iconName))
            {
                if (!Icons.TryGetValue(iconName, out icon) || icon == null)
                {
                    icon = EditorGUIUtility.IconContent(iconName)?.image;
                    if (icon != null) Icons[iconName] = icon;
                }
            }

            return new GUIContent(text ?? string.Empty, icon, current?.tooltip ?? string.Empty);
        }
    }
}
