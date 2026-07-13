using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>Runtime risk assigned to an MCP tool call after its action is resolved.</summary>
    internal enum UntermToolRisk
    {
        ReadOnly,
        Mutating,
        Dangerous,
    }

    /// <summary>
    /// Owns the MCP trust boundary. The bridge is disabled by default, read-only calls
    /// run without interruption once enabled, and every mutating or dangerous call
    /// requires a fresh Editor approval. Approval is deliberately not remembered.
    /// </summary>
    internal static class UntermMcpSecurity
    {
        internal const string EnabledPreferenceKey = "Unterm.Mcp.Enabled";

        /// <summary>Whether the user explicitly enabled the in-editor MCP bridge.</summary>
        public static bool Enabled => EditorPrefs.GetBool(EnabledPreferenceKey, false);

        /// <summary>Ask for explicit enablement from Preferences; no unattended enable path exists.</summary>
        public static bool TryEnableWithConfirmation()
        {
            if (Enabled) return true;
            bool approved = EditorUtility.DisplayDialog(
                "Enable Unterm MCP tools?",
                "Claude Code will be able to request Unity Editor operations. Read-only requests run " +
                "without another prompt. Every project mutation requires one-shot approval, and arbitrary " +
                "C# execution is always treated as dangerous. Approval-required calls are denied in batch mode.",
                "Enable MCP",
                "Cancel");
            if (!approved) return false;
            EditorPrefs.SetBool(EnabledPreferenceKey, true);
            return true;
        }

        /// <summary>Disable the bridge immediately and remove its published tool catalog.</summary>
        public static void Disable() => EditorPrefs.SetBool(EnabledPreferenceKey, false);

        /// <summary>Resolve a call's effective risk from its final tool name and action.</summary>
        public static UntermToolRisk Classify(string toolName, JObject args)
        {
            string action = (string)args?["action"] ?? "";
            switch (toolName)
            {
                case "unity_editor":
                    return action == "state" || string.IsNullOrEmpty(action) ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_scene":
                    return action == "info" || action == "hierarchy" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_gameobject":
                    return action == "find" || action == "get_info" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_component":
                    return action == "list" || action == "get" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_console":
                    return action == "get" || string.IsNullOrEmpty(action) ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_menu":
                    return action == "search" ? UntermToolRisk.ReadOnly : UntermToolRisk.Dangerous;
                case "unity_asset":
                    return action == "find" || action == "get_info" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_script":
                    return action == "read" || action == "validate" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Mutating;
                case "unity_material":
                    if (action == "get_info") return UntermToolRisk.ReadOnly;
                    return string.IsNullOrEmpty(action) ? UntermToolRisk.Dangerous : UntermToolRisk.Mutating;
                case "unity_prefab":
                    // Both current defaults (instantiate/create) mutate project state.
                    return UntermToolRisk.Mutating;
                case "unity_package":
                    return action == "list" || action == "info" || string.IsNullOrEmpty(action)
                        ? UntermToolRisk.ReadOnly : UntermToolRisk.Dangerous;
                case "unity_capture":
                case "unity_find":
                    return UntermToolRisk.ReadOnly;
                case "unity_execute_code":
                    return UntermToolRisk.Dangerous;
                default:
                    // New tools fail closed until their risk is deliberately classified.
                    return UntermToolRisk.Dangerous;
            }
        }

        /// <summary>Authorize one call. Mutating approvals are never cached or allowlisted.</summary>
        public static bool TryAuthorize(string toolName, JObject args, out string error)
        {
            if (!Enabled)
            {
                error = "Unterm MCP tools are disabled. Enable them explicitly in Preferences > Unterm.";
                return false;
            }

            UntermToolRisk risk = Classify(toolName, args);
            if (!RequiresOneShotApproval(risk))
            {
                error = null;
                return true;
            }

            if (Application.isBatchMode && !CanRunInBatchMode(risk))
            {
                error = $"{toolName} was denied: {risk.ToString().ToLowerInvariant()} MCP calls require interactive one-shot approval.";
                return false;
            }

            string arguments = args?.ToString(Formatting.Indented) ?? "{}";
            if (arguments.Length > 4000) arguments = arguments.Substring(0, 4000) + "\n… (truncated)";
            bool approved = EditorUtility.DisplayDialog(
                $"Approve {risk.ToString().ToLowerInvariant()} MCP action?",
                $"Tool: {toolName}\nRisk: {risk}\n\nArguments:\n{arguments}\n\nThis approval applies to this call only.",
                "Allow once",
                "Deny");
            if (approved)
            {
                error = null;
                return true;
            }

            error = $"{toolName} was denied by the user.";
            return false;
        }

        /// <summary>Whether a call needs a fresh user decision before execution.</summary>
        internal static bool RequiresOneShotApproval(UntermToolRisk risk) => risk != UntermToolRisk.ReadOnly;

        /// <summary>Batch mode can run only calls that never require a prompt.</summary>
        internal static bool CanRunInBatchMode(UntermToolRisk risk) => risk == UntermToolRisk.ReadOnly;

        /// <summary>Fixed catalog annotation; runtime action classification remains authoritative.</summary>
        public static JObject CatalogAnnotations(string toolName)
        {
            bool readOnly = toolName == "unity_capture" || toolName == "unity_find";
            return new JObject
            {
                ["title"] = toolName,
                ["readOnlyHint"] = readOnly,
                ["destructiveHint"] = !readOnly,
                ["openWorldHint"] = toolName == "unity_package" || toolName == "unity_execute_code",
            };
        }

        /// <summary>Human-readable policy appended to every MCP tool description.</summary>
        public static string DescriptionSuffix(string toolName)
        {
            if (toolName == "unity_execute_code")
                return " Security: dangerous; always requires one-shot Editor approval and is denied in batch mode.";
            if (toolName == "unity_capture" || toolName == "unity_find")
                return " Security: read-only after MCP is explicitly enabled.";
            return " Security: read actions run after MCP is enabled; mutation actions require one-shot Editor approval and are denied in batch mode.";
        }
    }
}
