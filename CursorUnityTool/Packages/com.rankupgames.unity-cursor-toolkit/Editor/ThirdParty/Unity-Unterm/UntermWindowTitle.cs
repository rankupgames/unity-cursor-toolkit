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
            Texture icon = null;
            if (!string.IsNullOrEmpty(iconName))
            {
                string themedIconName = EditorGUIUtility.isProSkin && !iconName.StartsWith("d_")
                    ? "d_" + iconName
                    : iconName;
                icon = ResolveIcon(themedIconName);
                if (icon == null && themedIconName != iconName)
                    icon = ResolveIcon(iconName);
            }

            // Unity may restore a generic serialized image before OnEnable. Prefer
            // the named tool icon above, using the restored image only as a final
            // fallback when the active Unity version does not expose that icon.
            icon ??= current?.image;
            return new GUIContent(text ?? string.Empty, icon, current?.tooltip ?? string.Empty);
        }

        private static Texture ResolveIcon(string iconName)
        {
            if (!Icons.TryGetValue(iconName, out Texture icon) || icon == null)
            {
                icon = EditorGUIUtility.IconContent(iconName)?.image;
                if (icon != null)
                {
                    Icons[iconName] = icon;
                }
            }
            return icon;
        }
    }
}
