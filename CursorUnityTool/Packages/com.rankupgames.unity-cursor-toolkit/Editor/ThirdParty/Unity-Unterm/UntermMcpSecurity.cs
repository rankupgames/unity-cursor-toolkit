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
        Unclassified,
    }

    /// <summary>Current-project trust granted to known MCP tool actions.</summary>
    internal enum UntermMcpAccessPolicy
    {
        Prompt,
        AllowMutating,
        AllowDangerous,
    }

    /// <summary>Pure authorization result before any Editor prompt is displayed.</summary>
    internal enum UntermMcpAuthorization
    {
        Allow,
        Prompt,
        Deny,
    }

    /// <summary>
    /// Owns the MCP trust boundary. Settings live in <see cref="EditorUserSettings"/>,
    /// so trust is local to this Unity project and is not committed or shared.
    /// </summary>
    internal static class UntermMcpSecurity
    {
        internal const string EnabledPreferenceKey = "Unterm.Mcp.Enabled";
        internal const string AccessPolicyPreferenceKey = "Unterm.Mcp.AccessPolicy";
        internal const string ArbitraryCSharpPreferenceKey = "Unterm.Mcp.AllowArbitraryCSharp";

        /// <summary>Whether the user explicitly enabled MCP for the current Unity project.</summary>
        public static bool Enabled => ReadBool(EnabledPreferenceKey);

        /// <summary>Unattended access granted for the current Unity project.</summary>
        public static UntermMcpAccessPolicy AccessPolicy => ParseAccessPolicy(EditorUserSettings.GetConfigValue(AccessPolicyPreferenceKey));

        /// <summary>Whether this project separately allows arbitrary C# without a one-shot prompt.</summary>
        public static bool AllowArbitraryCSharp => ReadBool(ArbitraryCSharpPreferenceKey);

        /// <summary>Ask for explicit MCP enablement for this project.</summary>
        public static bool TryEnableWithConfirmation()
        {
            if (Enabled) return true;
            bool approved = EditorUtility.DisplayDialog(
                "Enable Unterm MCP tools for this project?",
                "Claude Code will be able to request Unity Editor operations in this project. " +
                "Read-only requests run without another prompt. Other requests follow the current-project " +
                "access policy below; Prompt keeps one-shot approval and unattended prompt requests fail closed.",
                "Enable for this project",
                "Cancel");
            if (!approved) return false;
            WriteBool(EnabledPreferenceKey, true);
            return true;
        }

        /// <summary>Disable this project's bridge and revoke unattended trust.</summary>
        public static void Disable()
        {
            WriteBool(EnabledPreferenceKey, false);
            SetAccessPolicy(UntermMcpAccessPolicy.Prompt);
            WriteBool(ArbitraryCSharpPreferenceKey, false);
        }

        /// <summary>Apply a current-project policy change, confirming trust upgrades.</summary>
        public static bool TrySetAccessPolicyWithConfirmation(UntermMcpAccessPolicy nextPolicy)
        {
            if (!IsValidAccessPolicy(nextPolicy)) return false;
            UntermMcpAccessPolicy currentPolicy = AccessPolicy;
            if (nextPolicy == currentPolicy) return true;
            if (nextPolicy > currentPolicy)
            {
                string detail = nextPolicy == UntermMcpAccessPolicy.AllowDangerous
                    ? "Dangerous actions, including package changes and arbitrary menu execution, may run without a per-call prompt in this project. Arbitrary C# still requires its separate full-access opt-in."
                    : "Known project mutations may run without a per-call prompt in this project. Dangerous actions still use one-shot approval.";
                bool approved = EditorUtility.DisplayDialog(
                    "Increase Unterm MCP access for this project?",
                    detail + " Batch requests are allowed only within the selected project policy.",
                    "Apply project policy",
                    "Cancel");
                if (!approved) return false;
            }

            SetAccessPolicy(nextPolicy);
            if (nextPolicy != UntermMcpAccessPolicy.AllowDangerous)
                WriteBool(ArbitraryCSharpPreferenceKey, false);
            return true;
        }

        /// <summary>Apply the separate arbitrary-C# opt-in after a full-machine-access warning.</summary>
        public static bool TrySetAllowArbitraryCSharpWithConfirmation(bool allow)
        {
            if (!allow)
            {
                WriteBool(ArbitraryCSharpPreferenceKey, false);
                return true;
            }
            if (!Enabled || AccessPolicy != UntermMcpAccessPolicy.AllowDangerous) return false;
            bool approved = EditorUtility.DisplayDialog(
                "Allow arbitrary C# full-machine access?",
                "unity_execute_code runs inside the Unity Editor process with your user account. It can read or " +
                "write any accessible file, launch processes, use the network, inspect environment data, and change " +
                "the project or Editor. Enabling this removes per-call prompts for this project only.",
                "Allow full machine access",
                "Cancel");
            if (!approved) return false;
            WriteBool(ArbitraryCSharpPreferenceKey, true);
            return true;
        }

        /// <summary>Resolve a call's effective risk from its final tool name and action.</summary>
        public static UntermToolRisk Classify(string toolName, JObject args) => ClassifyAction(toolName, (string)args?["action"] ?? "");

        /// <summary>Pure risk classification used by the runtime and EditMode policy tests.</summary>
        internal static UntermToolRisk ClassifyAction(string toolName, string action)
        {
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
                    return UntermToolRisk.Unclassified;
            }
        }

        /// <summary>Pure project-policy decision used by interactive and batch authorization paths.</summary>
        internal static UntermMcpAuthorization ResolveAuthorization(bool enabled, UntermMcpAccessPolicy accessPolicy, UntermToolRisk risk, bool arbitraryCSharp, bool allowArbitraryCSharp, bool unattended)
        {
            if (!enabled) return UntermMcpAuthorization.Deny;
            if (risk == UntermToolRisk.ReadOnly) return UntermMcpAuthorization.Allow;
            if (!IsValidAccessPolicy(accessPolicy) || risk == UntermToolRisk.Unclassified)
                return unattended ? UntermMcpAuthorization.Deny : UntermMcpAuthorization.Prompt;

            bool policyAllows = risk == UntermToolRisk.Mutating
                ? accessPolicy >= UntermMcpAccessPolicy.AllowMutating
                : accessPolicy >= UntermMcpAccessPolicy.AllowDangerous;
            if (arbitraryCSharp)
                policyAllows = accessPolicy == UntermMcpAccessPolicy.AllowDangerous && allowArbitraryCSharp;
            if (policyAllows) return UntermMcpAuthorization.Allow;
            return unattended ? UntermMcpAuthorization.Deny : UntermMcpAuthorization.Prompt;
        }

        /// <summary>Authorize one call using this project's policy and a one-shot prompt when required.</summary>
        public static bool TryAuthorize(string toolName, JObject args, out string error)
        {
            UntermToolRisk risk = Classify(toolName, args);
            bool arbitraryCSharp = toolName == "unity_execute_code";
            UntermMcpAuthorization authorization = ResolveAuthorization(
                Enabled,
                AccessPolicy,
                risk,
                arbitraryCSharp,
                AllowArbitraryCSharp,
                Application.isBatchMode);
            if (authorization == UntermMcpAuthorization.Allow)
            {
                error = null;
                return true;
            }
            if (authorization == UntermMcpAuthorization.Deny)
            {
                error = DeniedReason(toolName, risk, arbitraryCSharp);
                return false;
            }

            string arguments = args?.ToString(Formatting.Indented) ?? "{}";
            if (arguments.Length > 4000) arguments = arguments.Substring(0, 4000) + "\n… (truncated)";
            string fullAccessWarning = arbitraryCSharp
                ? "\n\nWarning: arbitrary C# has full access to the Editor process and everything your user account can access."
                : "";
            bool approved = EditorUtility.DisplayDialog(
                $"Approve {risk.ToString().ToLowerInvariant()} MCP action?",
                $"Tool: {toolName}\nRisk: {risk}\n\nArguments:\n{arguments}{fullAccessWarning}\n\nThis approval applies to this call only.",
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
                return " Security: full machine and Editor access; unattended execution requires this project's dangerous-action policy plus the separate arbitrary-C# opt-in. Otherwise it requires one-shot approval and is denied in batch mode.";
            if (toolName == "unity_capture" || toolName == "unity_find")
                return " Security: read-only after MCP is explicitly enabled for this project.";
            return " Security: governed by this project's Prompt, Allow Mutating, or Allow Dangerous policy; requests outside that policy require one-shot approval and are denied in batch mode.";
        }

        /// <summary>Parse persisted project policy and fail closed on missing or invalid values.</summary>
        internal static UntermMcpAccessPolicy ParseAccessPolicy(string value)
        {
            if (Enum.TryParse(value, out UntermMcpAccessPolicy parsed) && IsValidAccessPolicy(parsed)) return parsed;
            return UntermMcpAccessPolicy.Prompt;
        }

        /// <summary>Whether a numeric enum value is a supported access policy.</summary>
        private static bool IsValidAccessPolicy(UntermMcpAccessPolicy policy) => policy >= UntermMcpAccessPolicy.Prompt && policy <= UntermMcpAccessPolicy.AllowDangerous;

        /// <summary>Persist a validated access policy in project-local Editor user settings.</summary>
        private static void SetAccessPolicy(UntermMcpAccessPolicy policy) => EditorUserSettings.SetConfigValue(AccessPolicyPreferenceKey, policy.ToString());

        /// <summary>Read a project-local boolean with a fail-closed false default.</summary>
        private static bool ReadBool(string key) => string.Equals(EditorUserSettings.GetConfigValue(key), bool.TrueString, StringComparison.OrdinalIgnoreCase);

        /// <summary>Persist a project-local boolean without writing project assets.</summary>
        private static void WriteBool(string key, bool value) => EditorUserSettings.SetConfigValue(key, value ? bool.TrueString : bool.FalseString);

        /// <summary>Explain why an unattended or disabled call was denied.</summary>
        private static string DeniedReason(string toolName, UntermToolRisk risk, bool arbitraryCSharp)
        {
            if (!Enabled) return "Unterm MCP tools are disabled for this project. Enable them explicitly in Preferences > Unterm.";
            if (risk == UntermToolRisk.Unclassified)
                return $"{toolName} was denied: unclassified MCP tools cannot run unattended.";
            if (arbitraryCSharp && !AllowArbitraryCSharp)
                return $"{toolName} was denied: batch execution requires Allow Dangerous plus the separate arbitrary-C# full-machine-access opt-in for this project.";
            return $"{toolName} was denied: {risk.ToString().ToLowerInvariant()} calls are not allowed unattended by this project's {AccessPolicy} policy.";
        }
    }
}
