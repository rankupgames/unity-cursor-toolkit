// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: Unity -batchmode entry point for game_command host=editorBatchmode.
// =============================================================================

#if UNITY_EDITOR

using System;
using System.IO;
using UnityEditor;

namespace UnityCursorToolkit.AgentCommands
{
	public static class BatchCommandEntry
	{
		public static void Run()
		{
			string result = "{\"success\":false,\"error\":\"Batch command did not run.\"}";
			string resultPath = string.Empty;
			int exitCode = 1;
			try
			{
				string[] args = Environment.GetCommandLineArgs();
				string action = GetArg(args, "-uctCommandAction", "list");
				string commandName = GetArg(args, "-uctCommandName", string.Empty);
				string argsPath = GetArg(args, "-uctCommandArgsPath", string.Empty);
				resultPath = GetArg(args, "-uctCommandResultPath", string.Empty);
				string commandArgsJson = File.Exists(argsPath) ? File.ReadAllText(argsPath) : "{}";

				if (action == "list")
				{
					result = AgentCommandRegistry.ToCatalogJson();
					exitCode = 0;
				}
				else if (action == "run")
				{
					if (string.IsNullOrEmpty(commandName))
					{
						result = Error("commandName is required for batchmode game_command run.");
					}
					else
					{
						result = AgentCommandRunner.Run(commandName, commandArgsJson).ToJson();
						exitCode = result.Contains("\"success\":false") ? 1 : 0;
					}
				}
				else
				{
					result = Error("Unsupported batchmode game_command action: " + action);
				}

				WriteResult(resultPath, result);
			}
			catch (Exception ex)
			{
				result = Error(ex.Message);
				WriteResult(resultPath, result);
			}

			if (result.Contains("\"success\":false"))
			{
				exitCode = 1;
			}

			EditorApplication.Exit(exitCode);
		}

		private static string GetArg(string[] args, string key, string fallback)
		{
			for (int i = 0; i < args.Length - 1; i++)
			{
				if (args[i] == key)
				{
					return args[i + 1];
				}
			}

			return fallback;
		}

		private static string Error(string message)
		{
			return "{\"success\":false,\"error\":\"" + AgentCommandJson.Escape(message) + "\"}";
		}

		private static void WriteResult(string resultPath, string result)
		{
			if (string.IsNullOrEmpty(resultPath))
			{
				return;
			}

			string directory = Path.GetDirectoryName(resultPath);
			if (string.IsNullOrEmpty(directory) == false)
			{
				Directory.CreateDirectory(directory);
			}

			File.WriteAllText(resultPath, result);
		}
	}
}

#endif
