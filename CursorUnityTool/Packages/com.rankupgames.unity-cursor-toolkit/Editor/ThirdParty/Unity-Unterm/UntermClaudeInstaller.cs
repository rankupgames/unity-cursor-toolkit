using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Unterm.Editor
{
    /// <summary>
    /// Downloads Anthropic's official standalone Claude Code engine binary from the
    /// npm registry into a per-user (not per-project) managed directory, so Unterm
    /// works even when the user hasn't installed <c>claude</c> themselves.
    ///
    /// We download rather than bundle on purpose: claude-code is "Copyright Anthropic
    /// PBC. All rights reserved." with no redistribution grant, so shipping it inside
    /// this package would be redistribution. Fetching it from Anthropic's official
    /// registry at the user's request is the same path <c>npm install</c> (and Zed's
    /// Claude Code integration) take — no redistribution happens.
    ///
    /// The binary is the platform package <c>@anthropic-ai/claude-agent-sdk-&lt;rid&gt;</c>
    /// — a Bun-compiled, self-contained native executable (~214MB) that needs no Node.
    /// The SDK package is pinned to a version tested with the native control driver.
    /// Each supported platform has a committed SHA-512 integrity value, and extraction
    /// accepts only the four-file layout published for that exact release.
    /// </summary>
    internal static class UntermClaudeInstaller
    {
        private const string Scope = "@anthropic-ai";
        private const string BasePackage = "claude-agent-sdk";
        private const long MaxArchiveBytes = 256L * 1024L * 1024L;
        private const long MaxBinaryBytes = 230L * 1024L * 1024L;
        private const long MaxMetadataBytes = 1024L * 1024L;

        /// <summary>
        /// SDK 0.3.183 embeds Claude Code 2.1.183. It was published on 2026-06-18,
        /// more than seven days before this pin was reviewed on 2026-07-13.
        /// </summary>
        internal const string PinnedVersion = "0.3.183";

        // WebClient (System.dll, always referenced — unlike System.Net.Http, whose
        // availability depends on the API compatibility level) follows redirects to
        // the registry CDN and lets us stream OpenRead() ourselves for progress.
        private static WebClient NewClient()
        {
            var wc = new WebClient();
            wc.Headers.Add(HttpRequestHeader.UserAgent, "Unterm");
            return wc;
        }

        /// The version that is actually usable right now — i.e. what the agent panel
        /// will launch — or "" if the reviewed version is not installed. Unreviewed
        /// sibling versions are never selected merely because they sort newer.
        internal static string InstalledVersion()
        {
            try
            {
                return File.Exists(BinaryPath(PinnedVersion)) ? PinnedVersion : "";
            }
            catch { return ""; }
        }

        /// Absolute path to the installed binary the agent panel will launch, or "".
        internal static string InstalledBinaryPath()
        {
            string v = InstalledVersion();
            return string.IsNullOrEmpty(v) ? "" : BinaryPath(v);
        }

        // Managed install root, keyed only on the OS user (NOT the project): one
        // download is shared across every Unity project. Deliberately not
        // Application.persistentDataPath, which is Company/Product (i.e. per-project).
        internal static string ManagedRoot()
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

        internal static string BinaryName =>
#if UNITY_EDITOR_WIN
            "claude.exe";
#else
            "claude";
#endif

        // Absolute path the binary would live at for a given version (may not exist).
        private static string BinaryPath(string version) =>
            Path.Combine(ManagedRoot(), version, BinaryName);

        // The npm RID for the platform package: <os>-<cpu>, matching Anthropic's
        // optionalDependencies (darwin-arm64, win32-x64, linux-arm64, ...). Unity
        // Editor on linux is glibc, so the non-musl variant is correct.
        private static string Rid()
        {
            string cpu = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
#if UNITY_EDITOR_WIN
            return "win32-" + cpu;
#elif UNITY_EDITOR_OSX
            return "darwin-" + cpu;
#else
            return "linux-" + cpu;
#endif
        }

        /// Download and install the pinned claude binary. Runs on a caller's background
        /// thread; <paramref name="onProgress"/> is invoked with (bytesDownloaded,
        /// totalBytes); totalBytes is 0 when the server sends no Content-Length.
        /// Returns null on success, or an error message on failure.
        internal static string Download(Action<long, long> onProgress)
        {
            string tmpDir = null;
            try
            {
                string rid = Rid();
                string pkgName = BasePackage + "-" + rid;     // claude-agent-sdk-darwin-arm64
                string expectedIntegrity = ExpectedIntegrity(rid);
                if (string.IsNullOrEmpty(expectedIntegrity))
                    return $"unsupported Claude Code platform: {rid}";

                // 1. Build the immutable npm tarball URL for the reviewed version.
                string version = PinnedVersion;
                string tarball = $"https://registry.npmjs.org/{Scope}/{pkgName}/-/{pkgName}-{version}.tgz";

                // 2. Download to a temp dir, hashing the bytes as they stream in.
                tmpDir = Path.Combine(ManagedRoot(), ".tmp-" + version + "-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tmpDir);
                string tgzPath = Path.Combine(tmpDir, "pkg.tgz");
                string sha512 = DownloadFile(tarball, tgzPath, onProgress);

                // 3. Verification is mandatory; there is no unverified install path.
                string want = expectedIntegrity.Substring("sha512-".Length);
                if (!string.Equals(want, sha512, StringComparison.Ordinal))
                    return $"integrity check failed for {pkgName}@{version}";

                // 4. Validate the complete archive layout, then stage package/<binary>.
                string staged = Path.Combine(tmpDir, BinaryName);
                string extractionError = ExtractBinary(tgzPath, staged);
                if (extractionError != null)
                    return $"invalid archive for {pkgName}@{version}: {extractionError}";

#if !UNITY_EDITOR_WIN
                Chmod755(staged);
#endif
                // 5. Move into <root>/<version>/ (replace any partial install there).
                string destDir = Path.Combine(ManagedRoot(), version);
                Directory.CreateDirectory(destDir);
                string destBin = Path.Combine(destDir, BinaryName);
                try { if (File.Exists(destBin)) File.Delete(destBin); } catch { /* in use: best effort */ }
                File.Move(staged, destBin);

                CleanupOtherVersions(version);
                return null;
            }
            catch (Exception e)
            {
                return e.Message;
            }
            finally
            {
                try { if (tmpDir != null && Directory.Exists(tmpDir)) Directory.Delete(tmpDir, true); }
                catch { /* leftover temp: harmless, cleaned on next install */ }
            }
        }

        // Stream a URL to disk, reporting (bytesRead, totalBytes) and returning the
        // base64 SHA-512 of the bytes (to match npm's dist.integrity).
        private static string DownloadFile(string url, string dest, Action<long, long> onProgress)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out Uri uri) || uri.Scheme != Uri.UriSchemeHttps ||
                !string.Equals(uri.Host, "registry.npmjs.org", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Claude Code download URL is not the approved npm registry");

            using var wc = NewClient();
            using var src = wc.OpenRead(url);
            long.TryParse(wc.ResponseHeaders?[HttpResponseHeader.ContentLength], out long total);
            if (total > MaxArchiveBytes)
                throw new InvalidDataException($"archive exceeds {MaxArchiveBytes} bytes");

            using var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA512);

            var buf = new byte[1 << 16];
            long read = 0;
            int n;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                dst.Write(buf, 0, n);
                hash.AppendData(buf, 0, n);
                read += n;
                if (read > MaxArchiveBytes)
                    throw new InvalidDataException($"archive exceeds {MaxArchiveBytes} bytes");
                onProgress?.Invoke(read, total);
            }
            return Convert.ToBase64String(hash.GetHashAndReset());
        }

        // Minimal tar-over-gzip reader for the reviewed four-file npm layout. Every
        // entry is validated before the staged executable becomes visible.
        internal static string ExtractBinary(string tgzPath, string destBin)
        {
            using var fs = new FileStream(tgzPath, FileMode.Open, FileAccess.Read);
            using var gz = new GZipStream(fs, CompressionMode.Decompress);

            string staged = destBin + ".extracting";
            if (File.Exists(staged)) File.Delete(staged);
            var expected = new HashSet<string>(StringComparer.Ordinal)
            {
                "package/" + BinaryName,
                "package/package.json",
                "package/LICENSE.md",
                "package/README.md",
            };
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var header = new byte[512];
            bool endMarker = false;
            try
            {
                while (ReadExact(gz, header, 512))
                {
                    if (IsAllZero(header))
                    {
                        endMarker = true;
                        break;
                    }

                    string name = ParseString(header, 0, 100);
                    if (!IsSafeArchivePath(name)) return "unsafe archive path: " + name;
                    if (!expected.Contains(name)) return "unexpected archive entry: " + name;
                    if (!seen.Add(name)) return "duplicate archive entry: " + name;

                    char typeflag = (char)header[156];
                    if (typeflag != '0' && typeflag != '\0')
                        return $"non-regular archive entry rejected: {name} (type {typeflag})";

                    long size = ParseOctal(header, 124, 12);
                    long maxSize = name == "package/" + BinaryName ? MaxBinaryBytes : MaxMetadataBytes;
                    if (size < 0 || size > maxSize) return $"archive entry is too large: {name}";
                    long padding = (512 - (size % 512)) % 512;

                    if (name == "package/" + BinaryName)
                    {
                        using (var outFs = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                            CopyN(gz, outFs, size);
                    }
                    else
                    {
                        Skip(gz, size);
                    }
                    Skip(gz, padding);
                }

                if (!endMarker) return "missing tar end marker";
                if (!seen.SetEquals(expected)) return "archive layout is incomplete";
                if (!File.Exists(staged)) return $"archive does not contain package/{BinaryName}";
                if (File.Exists(destBin)) File.Delete(destBin);
                File.Move(staged, destBin);
                return null;
            }
            finally
            {
                if (File.Exists(staged)) File.Delete(staged);
            }
        }

        private static bool IsSafeArchivePath(string name)
        {
            if (string.IsNullOrEmpty(name) || name.StartsWith("/", StringComparison.Ordinal) || name.Contains("\\"))
                return false;
            string[] parts = name.Split('/');
            foreach (string part in parts)
                if (string.IsNullOrEmpty(part) || part == "." || part == ".." || part.Contains(":"))
                    return false;
            return true;
        }

        private static string ExpectedIntegrity(string rid)
        {
            switch (rid)
            {
                case "darwin-arm64":
                    return "sha512-o/+sxwKgXuw6RG5cERWjvcvL1CDSPe/TaXMhax+dq+V4lDOI5iTqg3y5Wfb6dL3xlWoTA2OhWowDQllKbE04LQ==";
                case "darwin-x64":
                    return "sha512-V7Cf8JeD5EPf4MPomFUlEblCIQI0wg+aWdOSqvfMsDmCBEHljd52CQ3a7W263oVt6I7QUfRTpX2KNvdma56rDA==";
                case "win32-x64":
                    return "sha512-h/XzbrSmXGroTk/FYKR6J4/8G9vDb1HUUUeNXeBGqGW1kppIiWPJKLRzjtSe0brVjADOKOT6tE5IHK0mV/1gBw==";
                default:
                    return null;
            }
        }

        // Delete sibling version dirs so an Update reclaims the ~214MB of the old one.
        // A version still in use (a running claude holds the file open) only blocks
        // deletion on Windows, where it is silently skipped.
        private static void CleanupOtherVersions(string keep)
        {
            try
            {
                foreach (var dir in Directory.GetDirectories(ManagedRoot()))
                {
                    string name = Path.GetFileName(dir);
                    if (name == keep || name.StartsWith(".")) continue;
                    try { Directory.Delete(dir, true); } catch { /* in use: leave it */ }
                }
            }
            catch { /* root vanished: nothing to clean */ }
        }

#if !UNITY_EDITOR_WIN
        private static void Chmod755(string path)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo
                {
                    FileName = "/bin/chmod",
                    Arguments = "755 \"" + path + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                p?.WaitForExit(5000);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Unterm] chmod on claude binary failed: " + e.Message);
            }
        }
#endif

        // --- tar primitives ----------------------------------------------------

        private static bool ReadExact(Stream s, byte[] buf, int count)
        {
            int off = 0;
            while (off < count)
            {
                int n = s.Read(buf, off, count - off);
                if (n <= 0) return off == 0 ? false : throw new EndOfStreamException("truncated tar");
                off += n;
            }
            return true;
        }

        private static bool IsAllZero(byte[] buf)
        {
            foreach (var b in buf) if (b != 0) return false;
            return true;
        }

        private static string ParseString(byte[] buf, int off, int len)
        {
            int end = off;
            while (end < off + len && buf[end] != 0) end++;
            return System.Text.Encoding.ASCII.GetString(buf, off, end - off);
        }

        private static long ParseOctal(byte[] buf, int off, int len)
        {
            // GNU base-256 encoding for large sizes sets the high bit of the first byte.
            if ((buf[off] & 0x80) != 0)
            {
                long v = buf[off] & 0x7f;
                for (int i = 1; i < len; i++) v = (v << 8) | buf[off + i];
                return v;
            }
            int p = off, e = off + len;
            while (p < e && (buf[p] == ' ' || buf[p] == 0)) p++;
            long val = 0;
            while (p < e && buf[p] >= '0' && buf[p] <= '7') { val = val * 8 + (buf[p] - '0'); p++; }
            return val;
        }

        private static void CopyN(Stream src, Stream dst, long count)
        {
            var buf = new byte[1 << 16];
            while (count > 0)
            {
                int want = (int)Math.Min(buf.Length, count);
                int n = src.Read(buf, 0, want);
                if (n <= 0) throw new EndOfStreamException("truncated tar entry");
                dst.Write(buf, 0, n);
                count -= n;
            }
        }

        private static void Skip(Stream src, long count)
        {
            var buf = new byte[1 << 16];
            while (count > 0)
            {
                int want = (int)Math.Min(buf.Length, count);
                int n = src.Read(buf, 0, want);
                if (n <= 0) throw new EndOfStreamException("truncated tar entry");
                count -= n;
            }
        }
    }
}
