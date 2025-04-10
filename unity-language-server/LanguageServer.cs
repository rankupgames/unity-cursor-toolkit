// unity-language-server/LanguageServer.cs
// Changes: Created file, added basic LSP handlers (Initialize, Initialized, Shutdown, Exit, DidOpen, DidChange, DidSave, DidClose)
//          Implemented project path handling via constructor and command-line arg.

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.VisualStudio.LanguageServer.Protocol;
using StreamJsonRpc; // Required for JsonRpcMethod attribute

namespace UnityLanguageServer
{
    public class LanguageServer
    {
        private readonly ILogger<LanguageServer> _logger;
        private string _projectPath; // To store the path passed from the client (can be modified later if needed)
        private ServerCapabilities _serverCapabilities;

        // TODO: Inject/Create service classes for managing workspace, diagnostics, completions etc.
        // Example: private readonly WorkspaceManager _workspaceManager;

        public LanguageServer(ILogger<LanguageServer> logger, string projectPath)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _projectPath = projectPath; // Store the provided project path
            _logger.LogInformation($"Language Server instance created for project path: '{_projectPath ?? "Not Provided"}'");

            // Define server capabilities - we'll expand this in Phase 2 & 3
            _serverCapabilities = new ServerCapabilities
            {
                TextDocumentSync = new TextDocumentSyncOptions
                {
                    OpenClose = true, // Need DidOpen/DidClose notifications
                    Change = TextDocumentSyncKind.Incremental, // Send incremental changes (can adjust to Full if needed)
                    Save = new SaveOptions { IncludeText = false } // Notify on save (don't need full text on save)
                },
                // --- Placeholders for capabilities based on feature list (to be enabled in Phase 2/3) ---
                CompletionProvider = null, // Will be new CompletionOptions { TriggerCharacters = new[] { ".", " ", "(" } };
                HoverProvider = true, // Simple boolean or HoverOptions
                DefinitionProvider = true, // Simple boolean or DefinitionOptions
                ReferencesProvider = true, // Simple boolean or ReferenceOptions
                SignatureHelpProvider = null, // Will be new SignatureHelpOptions { TriggerCharacters = new[] { "(", "," } };
                RenameProvider = false, // Will be new RenameOptions { PrepareProvider = true };
                WorkspaceSymbolProvider = false, // Simple boolean or WorkspaceSymbolOptions
                DocumentFormattingProvider = false, // Simple boolean or DocumentFormattingOptions
                                                    // Add other capabilities here...
            };

            // Instantiate necessary services (e.g., WorkspaceManager) - To be done in Phase 2
            // _workspaceManager = new WorkspaceManager(loggerFactory.CreateLogger<WorkspaceManager>(), _projectPath);
        }

        [JsonRpcMethod(Methods.InitializeName)]
        public Task<InitializeResult> Initialize(InitializeParams @params, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Initialize request received.");

            // Store client capabilities? Useful for tailoring responses.
            // ClientCapabilities clientCapabilities = @params.Capabilities;

            // If project path wasn't provided via args, try getting it from initialization params
            if (string.IsNullOrEmpty(_projectPath))
            {
                // Prefer RootPath (older) or RootUri (newer)
                string rootPath = @params.RootPath ?? (@params.RootUri?.IsFile == true ? @params.RootUri.LocalPath : null);
                if (!string.IsNullOrEmpty(rootPath))
                {
                    _logger.LogInformation($"Project path not provided via args, using root from client: {rootPath}");
                    _projectPath = rootPath;
                    // TODO: Add validation that this path is actually a Unity project in Phase 3/4
                    // Consider if the WorkspaceManager needs to be re-initialized or updated here
                    // if (!_workspaceManager.IsInitialized) _workspaceManager.Initialize(_projectPath);
                }
                else
                {
                    _logger.LogWarning("Could not determine project root from client initialization parameters either.");
                    // Handle error case? Server might be unusable without a project path.
                }
            }

            // Return the server's capabilities
            return Task.FromResult(new InitializeResult
            {
                Capabilities = _serverCapabilities
            });
        }

        [JsonRpcMethod(Methods.InitializedName)]
        public Task Initialized(InitializedParams @params)
        {
            _logger.LogInformation("Client notification 'initialized' received.");
            // Now is a good time to start loading the workspace if a project path is known
            // Task.Run(async () => await _workspaceManager.LoadWorkspaceAsync()); // Fire and forget, or manage task
            return Task.CompletedTask;
        }

        [JsonRpcMethod(Methods.ShutdownName)]
        public Task Shutdown() // Can accept CancellationToken
        {
            _logger.LogInformation("Shutdown request received.");
            // Dispose resources, cancel ongoing operations
            // _workspaceManager?.Dispose();
            return Task.CompletedTask;
        }

        [JsonRpcMethod(Methods.ExitName)]
        public void Exit() // This method should be parameterless and void
        {
            _logger.LogInformation("Exit notification received. Server will allow shutdown.");
            // The JsonRpc connection completion in Program.cs handles the actual process exit.
            // Do not call Environment.Exit() here.
        }

        [JsonRpcMethod(Methods.TextDocumentDidOpenName)]
        public Task DidOpenTextDocument(DidOpenTextDocumentParams @params) // Can accept CancellationToken
        {
            _logger.LogInformation($"Document opened: {@params.TextDocument.Uri.ToString()}");
            // Pass to WorkspaceManager to add/update the document content
            // _workspaceManager?.UpdateDocument(@params.TextDocument.Uri, @params.TextDocument.Text);
            return Task.CompletedTask;
        }

        [JsonRpcMethod(Methods.TextDocumentDidChangeName)]
        public Task DidChangeTextDocument(DidChangeTextDocumentParams @params) // Can accept CancellationToken
        {
            // Assuming Incremental sync. If using Full, the logic is simpler (replace whole content).
            _logger.LogInformation($"Document changed: {@params.TextDocument.Uri.ToString()} ({@params.ContentChanges.Length} changes)");
            // Pass to WorkspaceManager to apply incremental changes
            // _workspaceManager?.UpdateDocument(@params.TextDocument.Uri, @params.ContentChanges);
            return Task.CompletedTask;
        }

        [JsonRpcMethod(Methods.TextDocumentDidSaveName)]
        public Task DidSaveTextDocument(DidSaveTextDocumentParams @params) // Can accept CancellationToken
        {
            _logger.LogInformation($"Document saved: {@params.TextDocument.Uri.ToString()}");
            // Optionally trigger actions like re-running diagnostics for the saved file
            // _workspaceManager?.RequestDiagnostics(@params.TextDocument.Uri);
            return Task.CompletedTask;
        }

        [JsonRpcMethod(Methods.TextDocumentDidCloseName)]
        public Task DidCloseTextDocument(DidCloseTextDocumentParams @params) // Can accept CancellationToken
        {
            _logger.LogInformation($"Document closed: {@params.TextDocument.Uri.ToString()}");
            // Pass to WorkspaceManager to potentially remove the document from active memory/analysis
            // _workspaceManager?.CloseDocument(@params.TextDocument.Uri);
            return Task.CompletedTask;
        }

        // --- Methods for features (to be implemented in Phase 2/3) ---

        /* Example Placeholder:
        [JsonRpcMethod(Methods.TextDocumentCompletionName)]
        public async Task<CompletionList> ProvideCompletionAsync(CompletionParams @params, CancellationToken cancellationToken)
        {
             _logger.LogInformation($"Completion requested for: {@params.TextDocument.Uri} at {@params.Position}");
             // return await _completionService.GetCompletionsAsync(@params.TextDocument.Uri, @params.Position, @params.Context, cancellationToken);
             return new CompletionList(); // Return empty list for now
        }
        */

        // ... Add other handlers for Hover, Definition, References, etc. ...

    }
}