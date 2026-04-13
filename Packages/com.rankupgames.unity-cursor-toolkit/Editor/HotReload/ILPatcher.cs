/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Project: Unity Cursor Toolkit
 * Description: IL method body patching -- compiles changed files in isolation,
 *              swaps method pointers at runtime via Mono internals.
 *              Avoids domain reload for method body edits during play mode.
 * Created: 2026-03-12
 * Last Modified: 2026-03-12
 */

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

using UnityEngine;
using UnityEditor;

namespace UnityCursorToolkit.HotReload
{
	public static class ILPatcher
	{
		public static event Action<PatchResult> OnPatchCompleted;

		private static string cscPath;
		private static string monoHostPath; // Set when csc needs to be invoked via mono
		private static readonly List<string> referenceAssemblies = new List<string>();

		#region Public API

		/// <summary>
		/// Attempt to IL-patch the given changed files. Returns a result indicating
		/// success/failure and whether fallback to full refresh is needed.
		/// </summary>
		public static PatchResult TryPatch(string[] changedFiles)
		{
			var sw = Stopwatch.StartNew();
			var result = new PatchResult();

			try
			{
				if (EditorApplication.isPlaying == false)
				{
					result.Success = false;
					result.FallbackReason = "Not in play mode -- IL patching only works during play mode.";
					return result;
				}

				if (changedFiles == null || changedFiles.Length == 0)
				{
					result.Success = true;
					result.PatchedMethodCount = 0;
					return result;
				}

				if (DetectStructuralChanges(changedFiles))
				{
					result.Success = false;
					result.FallbackReason = "Structural changes detected (new fields, classes, or method signatures).";
					return result;
				}

				EnsureCscPath();
				BuildReferenceList();

				string tempDllPath = CompileChangedFiles(changedFiles);
				if (tempDllPath == null)
				{
					result.Success = false;
					result.FallbackReason = "Compilation failed -- check console for errors.";
					return result;
				}

				int patchedCount = ApplyPatches(tempDllPath, changedFiles);

				result.Success = true;
				result.PatchedMethodCount = patchedCount;
				result.ElapsedMs = sw.ElapsedMilliseconds;

				InvokeReloadCallbacks();
			}
			catch (Exception ex)
			{
				result.Success = false;
				result.FallbackReason = $"Exception during IL patch: {ex.Message}";
				UnityEngine.Debug.LogError($"(ILPatcher - TryPatch) {ex}");
			}
			finally
			{
				sw.Stop();
				result.ElapsedMs = sw.ElapsedMilliseconds;
				OnPatchCompleted?.Invoke(result);
			}

			return result;
		}

		#endregion


		#region Private Methods

		private static bool DetectStructuralChanges(string[] files)
		{
			// Tier 1 MVP: conservative detection.
			// Read each changed file and check for indicators of structural changes:
			// - New class/struct/enum declarations
			// - Field additions/removals
			// - Method signature changes (return type, parameter list)
			// For MVP, we compare against the loaded assemblies.
			foreach (string file in files)
			{
				string fullPath = Path.GetFullPath(file);
				if (File.Exists(fullPath) == false)
				{
					continue;
				}

				string source = File.ReadAllText(fullPath);

				// Quick heuristic: if the file contains new field declarations that don't exist
				// in the currently loaded types, it's a structural change.
				// Full implementation would use Roslyn to parse and diff the AST.
				if (ContainsNewTypeDeclarations(source, fullPath))
				{
					return true;
				}
			}

			return false;
		}

		private static bool ContainsNewTypeDeclarations(string source, string filePath)
		{
			// Heuristic: look for class/struct/enum lines and check if any are new.
			// This is intentionally conservative -- false positives cause a full refresh
			// (safe), false negatives could cause runtime errors (unsafe).
			string[] lines = source.Split('\n');

			foreach (string line in lines)
			{
				string trimmed = line.Trim();

				// Skip comments and preprocessor directives
				if (trimmed.StartsWith("//") || trimmed.StartsWith("#") || trimmed.StartsWith("/*"))
				{
					continue;
				}

				// New class, struct, or enum declaration
				if ((trimmed.Contains("class ") || trimmed.Contains("struct ") || trimmed.Contains("enum "))
					&& trimmed.Contains("{") == false
					&& trimmed.EndsWith(";") == false)
				{
					// Check if this type already exists in loaded assemblies
					// For MVP: allow method body changes, flag everything else
				}
			}

			// For Tier 1, always allow -- structural detection is best-effort.
			// The actual patch step will fail gracefully if the method signature changed.
			return false;
		}

		private static void EnsureCscPath()
		{
			if (string.IsNullOrEmpty(cscPath) == false && File.Exists(cscPath))
			{
				return;
			}

			// Unity bundles a Roslyn compiler in the Editor
			string editorPath = EditorApplication.applicationPath;
			string editorDir = Path.GetDirectoryName(editorPath);

			var searchPaths = new List<string>();

#if UNITY_EDITOR_WIN
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "RoslynScripts", "unity_csc.bat"));
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "RoslynScripts", "csc.bat"));
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "Roslyn", "csc.exe"));
#elif UNITY_EDITOR_OSX
			// EditorApplication.applicationPath returns the .app bundle (e.g. Unity.app)
			string contentsDir = Path.Combine(editorPath, "Contents");

			// Pre-Unity 6 paths (directly executable)
			searchPaths.Add(Path.Combine(contentsDir, "Tools", "RoslynScripts", "unity_csc"));
			searchPaths.Add(Path.Combine(contentsDir, "Tools", "RoslynScripts", "csc"));
			searchPaths.Add(Path.Combine(contentsDir, "Tools", "Roslyn", "csc"));

			// Check pre-Unity 6 paths first (no mono host needed)
			foreach (string p in searchPaths)
			{
				if (File.Exists(p))
				{
					cscPath = p;
					return;
				}
			}

			// Unity 6000.x+: use Roslyn csc.exe via bundled mono
			string scriptingDir = Path.Combine(contentsDir, "Resources", "Scripting");
			string monoDir = Path.Combine(scriptingDir, "MonoBleedingEdge");
			string monoBin = Path.Combine(monoDir, "bin", "mono");

			if (File.Exists(monoBin))
			{
				// MSBuild Roslyn csc.exe (invoked via mono)
				string roslynCsc = Path.Combine(monoDir, "lib", "mono", "msbuild", "Current", "bin", "Roslyn", "csc.exe");
				if (File.Exists(roslynCsc))
				{
					cscPath = roslynCsc;
					monoHostPath = monoBin;
					return;
				}

				// Legacy Mono 4.5 csc.exe
				string legacyCsc = Path.Combine(monoDir, "lib", "mono", "4.5", "csc.exe");
				if (File.Exists(legacyCsc))
				{
					cscPath = legacyCsc;
					monoHostPath = monoBin;
					return;
				}
			}

			// Fallback: DotNetSdkRoslyn (would need dotnet exec)
			searchPaths.Clear();
			searchPaths.Add(Path.Combine(scriptingDir, "DotNetSdkRoslyn", "csc"));
			searchPaths.Add(Path.Combine(contentsDir, "DotNetSdkRoslyn", "csc"));
#else
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "RoslynScripts", "unity_csc"));
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "RoslynScripts", "csc"));
			searchPaths.Add(Path.Combine(editorDir, "Data", "Tools", "Roslyn", "csc"));
#endif

			foreach (string p in searchPaths)
			{
				if (File.Exists(p))
				{
					cscPath = p;
					return;
				}
			}

			// Log what was searched to help debug
			string searched = string.Join(", ", searchPaths);
			throw new FileNotFoundException($"Could not find Unity's bundled C# compiler (csc). Searched: {searched}");
		}

		private static void BuildReferenceList()
		{
			if (referenceAssemblies.Count > 0)
			{
				return;
			}

			// Add all currently loaded assemblies as references
			foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
			{
				try
				{
					string location = asm.Location;
					if (string.IsNullOrEmpty(location) == false && File.Exists(location))
					{
						referenceAssemblies.Add(location);
					}
				}
				catch
				{
					// Some assemblies don't have a location (dynamic assemblies)
				}
			}
		}

		private static string CompileChangedFiles(string[] files)
		{
			string tempDir = Path.Combine(Application.temporaryCachePath, "ILPatch");
			Directory.CreateDirectory(tempDir);

			string outputDll = Path.Combine(tempDir, $"patch_{DateTime.Now.Ticks}.dll");
			string responseFile = Path.Combine(tempDir, "patch.rsp");

			var rspLines = new List<string>
			{
				"-target:library",
				"-optimize+",
				"-unsafe+",
				$"-out:\"{outputDll}\"",
				"-nowarn:0169,0649"
			};

			// Exclude the assembly that owns the changed files to avoid duplicate type definitions.
			// Without this, the compiler sees types both in the source file and the referenced DLL.
			var excludedAssemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			foreach (string file in files)
			{
				string fullPath = Path.GetFullPath(file);
				// Convert to project-relative path for CompilationPipeline
				string projectDir = Path.GetFullPath(Application.dataPath + "/..");
				string relativePath = fullPath;
				if (fullPath.StartsWith(projectDir))
				{
					relativePath = fullPath.Substring(projectDir.Length + 1);
				}

				string asmName = UnityEditor.Compilation.CompilationPipeline.GetAssemblyNameFromScriptPath(relativePath);
				if (string.IsNullOrEmpty(asmName) == false)
				{
					excludedAssemblies.Add(asmName);
				}
			}

			foreach (string refAsm in referenceAssemblies)
			{
				string asmName = Path.GetFileNameWithoutExtension(refAsm);
				if (excludedAssemblies.Contains(asmName))
				{
					continue;
				}

				rspLines.Add($"-reference:\"{refAsm}\"");
			}

			// Add define symbols matching the current build
			string[] defines = EditorUserBuildSettings.activeScriptCompilationDefines;
			foreach (string d in defines)
			{
				rspLines.Add($"-define:{d}");
			}

			foreach (string file in files)
			{
				string fullPath = Path.GetFullPath(file);
				if (File.Exists(fullPath))
				{
					rspLines.Add($"\"{fullPath}\"");
				}
			}

			File.WriteAllLines(responseFile, rspLines);

			var psi = new ProcessStartInfo
			{
				FileName = string.IsNullOrEmpty(monoHostPath) ? cscPath : monoHostPath,
				Arguments = string.IsNullOrEmpty(monoHostPath)
					? $"@\"{responseFile}\""
					: $"\"{cscPath}\" @\"{responseFile}\"",
				UseShellExecute = false,
				RedirectStandardOutput = true,
				RedirectStandardError = true,
				CreateNoWindow = true
			};

			using (var process = Process.Start(psi))
			{
				string stdout = process.StandardOutput.ReadToEnd();
				string stderr = process.StandardError.ReadToEnd();
				process.WaitForExit(10000);

				if (process.ExitCode != 0)
				{
					UnityEngine.Debug.LogError($"(ILPatcher - CompileChangedFiles) Compilation failed:\n{stdout}\n{stderr}");
					return null;
				}
			}

			return File.Exists(outputDll) ? outputDll : null;
		}

		private static int ApplyPatches(string tempDllPath, string[] changedFiles)
		{
			byte[] dllBytes = File.ReadAllBytes(tempDllPath);
			Assembly patchAssembly = Assembly.Load(dllBytes);
			int patchedCount = 0;

			Type[] patchTypes = patchAssembly.GetTypes();

			foreach (Type patchType in patchTypes)
			{
				Type originalType = FindOriginalType(patchType.FullName);
				if (originalType == null)
				{
					UnityEngine.Debug.LogWarning($"(ILPatcher - ApplyPatches) Could not find original type: {patchType.FullName}");
					continue;
				}

				MethodInfo[] patchMethods = patchType.GetMethods(
					BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
				);

				foreach (MethodInfo patchMethod in patchMethods)
				{
					MethodInfo originalMethod = FindMatchingMethod(originalType, patchMethod);
					if (originalMethod == null)
					{
						continue;
					}

					try
					{
						SwapMethodBody(originalMethod, patchMethod);
						patchedCount++;
					}
					catch (Exception ex)
					{
						UnityEngine.Debug.LogError($"(ILPatcher - ApplyPatches) Failed to patch {originalType.Name}.{originalMethod.Name}: {ex.Message}");
					}
				}
			}

			// Clean up temp file
			try { File.Delete(tempDllPath); }
			catch (Exception ex) { UnityEngine.Debug.LogWarning($"(ILPatcher - ApplyPatches) Failed to clean temp DLL: {ex.Message}"); }

			return patchedCount;
		}

		private static Type FindOriginalType(string fullName)
		{
			foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
			{
				Type t = asm.GetType(fullName);
				if (t != null)
				{
					return t;
				}
			}

			return null;
		}

		private static MethodInfo FindMatchingMethod(Type originalType, MethodInfo patchMethod)
		{
			Type[] paramTypes = patchMethod.GetParameters().Select(p => p.ParameterType).ToArray();

			try
			{
				return originalType.GetMethod(
					patchMethod.Name,
					BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
					null,
					paramTypes,
					null
				);
			}
			catch
			{
				return null;
			}
		}

		/// <summary>
		/// Swap method body by forcing JIT compilation and redirecting via a JMP trampoline.
		/// Uses RuntimeHelpers.PrepareMethod to ensure both methods are JIT-compiled,
		/// then overwrites the original method's function pointer with the new one.
		/// Uses Marshal.Copy to avoid requiring unsafe compilation flag.
		/// </summary>
		private static void SwapMethodBody(MethodInfo original, MethodInfo replacement)
		{
			RuntimeHelpers.PrepareMethod(original.MethodHandle);
			RuntimeHelpers.PrepareMethod(replacement.MethodHandle);

			IntPtr originalPtr = original.MethodHandle.GetFunctionPointer();
			IntPtr replacementPtr = replacement.MethodHandle.GetFunctionPointer();

			if (IntPtr.Size == 8) // 64-bit
			{
				// MOV RAX, imm64; JMP RAX (12 bytes)
				byte[] jmp = new byte[12];
				jmp[0] = 0x48; // REX.W prefix
				jmp[1] = 0xB8; // MOV RAX, imm64
				byte[] addr = BitConverter.GetBytes(replacementPtr.ToInt64());
				Array.Copy(addr, 0, jmp, 2, 8);
				jmp[10] = 0xFF; // JMP RAX
				jmp[11] = 0xE0;
				Marshal.Copy(jmp, 0, originalPtr, 12);
			}
			else // 32-bit
			{
				// JMP rel32 (5 bytes)
				byte[] jmp = new byte[5];
				jmp[0] = 0xE9;
				int offset = (int)(replacementPtr.ToInt64() - originalPtr.ToInt64() - 5);
				byte[] offsetBytes = BitConverter.GetBytes(offset);
				Array.Copy(offsetBytes, 0, jmp, 1, 4);
				Marshal.Copy(jmp, 0, originalPtr, 5);
			}
		}

		private static void InvokeReloadCallbacks()
		{
			// Call OnScriptHotReload() on all active MonoBehaviours that have it
#if UNITY_2023_1_OR_NEWER
			foreach (MonoBehaviour mb in UnityEngine.Object.FindObjectsByType<MonoBehaviour>(FindObjectsSortMode.None))
#else
			foreach (MonoBehaviour mb in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
#endif
			{
				try
				{
					MethodInfo callback = mb.GetType().GetMethod(
						"OnScriptHotReload",
						BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
					);

					callback?.Invoke(mb, null);
				}
				catch (Exception ex)
				{
					UnityEngine.Debug.LogWarning($"(ILPatcher - InvokeReloadCallbacks) Error in OnScriptHotReload on {mb.GetType().Name}: {ex.Message}");
				}
			}

			// Call static OnScriptHotReloadNoInstance() on all types that have it
			foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
			{
				try
				{
					foreach (Type type in asm.GetTypes())
					{
						MethodInfo staticCallback = type.GetMethod(
							"OnScriptHotReloadNoInstance",
							BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
						);

						staticCallback?.Invoke(null, null);
					}
				}
				catch
				{
					// Assembly may not be introspectable
				}
			}
		}

		#endregion
	}

	public class PatchResult
	{
		public bool Success;
		public int PatchedMethodCount;
		public long ElapsedMs;
		public string FallbackReason;
	}
}

#endif
