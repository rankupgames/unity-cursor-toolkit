// Initial structure for the Unity Language Server
// Author: Your Name / Rank Up Games LLC (using Gemini assistance)
// Date: [Current Date]
// Changes: Initial file creation with basic LSP stdio setup.

using System;
using System.Diagnostics;
using System.Linq; // Required for args.FirstOrDefault
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StreamJsonRpc;
using Microsoft.VisualStudio.LanguageServer.Protocol;

namespace UnityLanguageServer
{
    class Program
    {
        static async Task Main(string[] args)
        {
            // Basic logging setup
            using var loggerFactory = LoggerFactory.Create(builder =>
            {
                builder
                    .AddConsole()
                    .SetMinimumLevel(LogLevel.Information); // Adjust log level as needed
            });
            var logger = loggerFactory.CreateLogger<Program>();

            logger.LogInformation("Unity Language Server starting...");

#if DEBUG
            // Optional: Attach debugger if running in debug mode and requested
            if (args.Contains("--debug"))
            {
                logger.LogWarning("Waiting for debugger to attach...");
                while (!Debugger.IsAttached)
                {
                    await Task.Delay(1000);
                }
                Debugger.Break();
                logger.LogInformation("Debugger attached.");
            }
#endif

            // Parse command line arguments
            string projectPath = ParseArgument(args, "--projectPath");
            if (string.IsNullOrEmpty(projectPath))
            {
                logger.LogWarning("No --projectPath argument provided. Server might rely on client's rootUri during initialization.");
                // Optionally set a default or handle error if path is strictly required at startup
            }
            else
            {
                logger.LogInformation($"Project path specified via command line: {projectPath}");
            }

            // Set up LSP communication over Standard Input/Output
            var stdIn = Console.OpenStandardInput();
            var stdOut = Console.OpenStandardOutput();

            try
            {
                // Create the JsonRpc message handler
                var messageHandler = new JsonRpcMessageHandler(stdIn, stdOut);

                // Create the server instance (implementing ILanguageServer defined later)
                var server = new LanguageServer(loggerFactory.CreateLogger<LanguageServer>(), projectPath);

                // Set up JSON RPC
                using var jsonRpc = new JsonRpc(messageHandler);

                // Add the server implementation to handle incoming requests
                jsonRpc.AddLocalRpcTarget(server);

                // Start listening for incoming messages
                jsonRpc.StartListening();

                logger.LogInformation("Server listening for LSP client connection...");

                // Wait for the RPC connection to close (usually when the client disconnects)
                await jsonRpc.Completion;

                logger.LogInformation("Client disconnected.");
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "An unexpected error occurred in the language server.");
                Environment.ExitCode = 1;
            }
            finally
            {
                logger.LogInformation("Unity Language Server shutting down.");
            }
        }

        // Helper to parse simple key=value arguments
        private static string ParseArgument(string[] args, string argName)
        {
            // Expects argument like "--projectPath=C:\Path\To\Project" or "--projectPath C:\Path\To\Project"
            string argumentPrefix = $"{argName}=";
            string value = args.FirstOrDefault(a => a.StartsWith(argumentPrefix))?.Substring(argumentPrefix.Length);

            if (string.IsNullOrEmpty(value))
            {
                // Try space-separated "--projectPath C:\Path"
                int index = Array.FindIndex(args, a => a.Equals(argName, StringComparison.OrdinalIgnoreCase));
                if (index >= 0 && index + 1 < args.Length)
                {
                    value = args[index + 1];
                }
            }

            // Trim quotes if present
            return value?.Trim('"', '\'');
        }
    }
}