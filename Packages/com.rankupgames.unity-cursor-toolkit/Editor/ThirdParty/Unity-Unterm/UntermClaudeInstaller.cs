using System;
using System.Collections.Generic;
using System.IO;

namespace Unterm.Editor
{
    /// <summary>
    /// Locates an existing Claude Code executable for the optional agent panel.
    /// The historical class name is retained to avoid unnecessary package churn;
    /// Unterm no longer downloads, installs, or updates Claude Code.
    /// </summary>
    internal static class UntermClaudeInstaller
    {
        private const string LegacyPinnedVersion = "0.3.183";

        internal static string BinaryName =>
#if UNITY_EDITOR_WIN
            "claude.exe";
#else
            "claude";
#endif

        /// <summary>Returns an existing Claude executable path, or an empty string.</summary>
        internal static string InstalledBinaryPath()
        {
            var seen = new HashSet<string>(
#if UNITY_EDITOR_WIN
                StringComparer.OrdinalIgnoreCase
#else
                StringComparer.Ordinal
#endif
            );

            string configured = ExistingPath(Environment.GetEnvironmentVariable("UNTERM_CLAUDE_PATH"));
            if (!string.IsNullOrEmpty(configured)) return configured;

            string fromPath = FindOnPath(Environment.GetEnvironmentVariable("PATH"));
            if (!string.IsNullOrEmpty(fromPath)) return fromPath;

            foreach (string candidate in CommonInstallPaths())
            {
                string resolved = ExistingPath(candidate);
                if (!string.IsNullOrEmpty(resolved) && seen.Add(resolved)) return resolved;
            }

            // Keep an already-installed legacy managed binary usable, but never fetch
            // or update it. This avoids breaking users who installed it in an older build.
            return ExistingPath(Path.Combine(LegacyManagedRoot(), LegacyPinnedVersion, BinaryName));
        }

        internal static string FindOnPath(string pathValue)
        {
            if (string.IsNullOrWhiteSpace(pathValue)) return string.Empty;
            foreach (string rawDirectory in pathValue.Split(Path.PathSeparator))
            {
                string directory = rawDirectory.Trim().Trim('"');
                if (string.IsNullOrEmpty(directory)) continue;
                string resolved = ExistingPath(Path.Combine(directory, BinaryName));
                if (!string.IsNullOrEmpty(resolved)) return resolved;
            }
            return string.Empty;
        }

        private static string ExistingPath(string candidate)
        {
            if (string.IsNullOrWhiteSpace(candidate)) return string.Empty;
            try
            {
                string fullPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(candidate));
                return File.Exists(fullPath) ? fullPath : string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static IEnumerable<string> CommonInstallPaths()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
#if UNITY_EDITOR_WIN
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!string.IsNullOrEmpty(local))
                yield return Path.Combine(local, "Programs", "claude", BinaryName);
            if (!string.IsNullOrEmpty(home))
                yield return Path.Combine(home, ".local", "bin", BinaryName);
#elif UNITY_EDITOR_OSX
            if (!string.IsNullOrEmpty(home))
            {
                yield return Path.Combine(home, ".local", "bin", BinaryName);
                yield return Path.Combine(home, ".bun", "bin", BinaryName);
                yield return Path.Combine(home, ".npm-global", "bin", BinaryName);
            }
            yield return "/opt/homebrew/bin/claude";
            yield return "/usr/local/bin/claude";
#else
            if (!string.IsNullOrEmpty(home))
            {
                yield return Path.Combine(home, ".local", "bin", BinaryName);
                yield return Path.Combine(home, ".bun", "bin", BinaryName);
                yield return Path.Combine(home, ".npm-global", "bin", BinaryName);
            }
            yield return "/usr/local/bin/claude";
#endif
        }

        private static string LegacyManagedRoot()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
#if UNITY_EDITOR_WIN
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(baseDir)) baseDir = Path.Combine(home, "AppData", "Local");
            return Path.Combine(baseDir, "dev.tnayuki.unterm", "claude");
#elif UNITY_EDITOR_OSX
            return Path.Combine(home, "Library", "Application Support", "dev.tnayuki.unterm", "claude");
#else
            string xdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
            string baseDir = string.IsNullOrEmpty(xdg) ? Path.Combine(home, ".local", "share") : xdg;
            return Path.Combine(baseDir, "dev.tnayuki.unterm", "claude");
#endif
        }
    }
}
