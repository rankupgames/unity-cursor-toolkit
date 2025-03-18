# Creating a VS Code Hot Reload Extension for Unity

## Building a Hot Reload Extension

1. **Setup basics**:
   ```bash
   npm install -g yo generator-code
   yo code
   ```

2. **Core functionality**:
   ```javascript
   // Listen for file changes
   const watcher = vscode.workspace.createFileSystemWatcher("**/*.cs");
   watcher.onDidChange(uri => {
     // Trigger Unity refresh via Unity Editor API
     triggerUnityRefresh();
   });
   ```

3. **Unity communication**:
   - Create a Unity Editor script that exposes an endpoint
   - Use TCP/IP sockets or named pipes to communicate between VS Code and Unity
   - Send refresh commands when files change

4. **Implement Asset Database refresh**:
   ```csharp
   // Unity Editor script
   [InitializeOnLoad]
   public class HotReloadHandler : EditorWindow {
     static HotReloadHandler() {
       EditorApplication.update += ListenForExternalChanges;
     }
     
     static void ListenForExternalChanges() {
       // Listen for VS Code signals
       if (receivedRefreshSignal) {
         AssetDatabase.Refresh();
         CompilationPipeline.RequestScriptCompilation();
       }
     }
   }
   ```

## Enhanced Socket Management

To handle common socket binding issues in Unity:

1. **Multi-port Support**:
   ```csharp
   // Unity script
   private static int port = 55500;
   
   private static void ListenerThreadFunction() {
     // Try multiple ports if necessary
     int[] portsToTry = new int[] { port, 55501, 55502, 55503, 55504 };
     
     foreach (int currentPort in portsToTry) {
       try {
         server = new TcpListener(IPAddress.Parse("127.0.0.1"), currentPort);
         server.Start();
         port = currentPort; // Store the successful port
         break;
       }
       catch (SocketException ex) {
         // 10048 is "address already in use" on Windows
         if (ex.ErrorCode == 10048 || ex.ErrorCode == 48) {
           continue; // Try next port
         }
         throw; // Rethrow other socket errors
       }
     }
   }
   ```

2. **Client-side Port Discovery**:
   ```typescript
   // VS Code extension
   const ALTERNATIVE_PORTS = [55500, 55501, 55502, 55503, 55504];
   
   function tryConnectToPort(portIndex: number) {
     if (portIndex >= ALTERNATIVE_PORTS.length) {
       return; // Failed to connect on any port
     }
     
     const port = ALTERNATIVE_PORTS[portIndex];
     socketClient = new net.Socket();
     
     socketClient.on('error', () => {
       // Try next port
       tryConnectToPort(portIndex + 1);
     });
     
     socketClient.connect(port, 'localhost', () => {
       console.log(`Connected to Unity on port ${port}`);
     });
   }
   ```

## Single Instance Management

1. **Using Mutex for Safety**:
   ```csharp
   // In Unity script
   private static Mutex instanceMutex;
   
   public static void Initialize() {
     // Acquire a named mutex to prevent multiple instances
     instanceMutex = new Mutex(true, "UnityHotReloadHandler", out bool createdNew);
     
     if (!createdNew) {
       Debug.Log("Another instance is already running.");
       instanceMutex.Close();
       instanceMutex = null;
       return;
     }
     
     // Start server...
   }
   ```

2. **Proper Resource Cleanup**:
   ```csharp
   // Register cleanup handlers
   AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
   EditorApplication.quitting += OnEditorQuitting;
   
   // Clean up when Unity is quitting
   private static void OnEditorQuitting() {
     Shutdown();
   }
   ```

## UI Improvements

1. **Status Bar Integration**:
   ```typescript
   // Create and manage status bar items
   function createStatusBarItems(context: vscode.ExtensionContext) {
     // Hot Reload toggle button
     hotReloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
     hotReloadStatusBarItem.command = 'unity-cursor-toolkit.toggleHotReload';
     
     // Select Project button
     selectProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
     selectProjectStatusBarItem.text = "$(file-directory) Select Unity Project";
     selectProjectStatusBarItem.command = 'unity-cursor-toolkit.selectUnityProject';
     
     // Install Script button
     installScriptStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
     installScriptStatusBarItem.text = "$(cloud-download) Install Unity Script";
     installScriptStatusBarItem.command = 'unity-cursor-toolkit.installUnityScript';
   }
   ```

2. **External Project Selection**:
   ```typescript
   // Function to select a Unity project using file dialog
   async function selectUnityProject(): Promise<vscode.Uri | undefined> {
     const options: vscode.OpenDialogOptions = {
       canSelectMany: false,
       canSelectFiles: false,
       canSelectFolders: true,
       openLabel: 'Select Unity Project Folder'
     };
     
     const folderUri = await vscode.window.showOpenDialog(options);
     // Install script to selected project...
   }
   ```

## Purpose-Built Integration

Rider's Unity integration is "purpose-built" meaning:

1. **Deep coordination**: JetBrains and Unity Technologies collaborated directly
2. **Access to internal APIs**: Rider can use Unity's internal APIs not publicly available
3. **Custom debugging pipeline**: Built specifically for Unity's debugging protocol
4. **Unity-specific inspections**: Understands Unity-specific code patterns
5. **Integrated documentation**: Unity API docs built directly into IDE tooltips

The collaboration began around 2017, with Unity offering official support to JetBrains to make Rider a first-class Unity development environment. This partnership allowed Rider to implement deeper integration than what's possible through public APIs alone.

## Hot Reload Solution Handling

For VS Code extension implementation that handles Unity solutions:

```javascript
// Monitor .sln and .csproj files
const solutionWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,csproj}");
solutionWatcher.onDidChange(uri => handleSolutionChange(uri));

function handleSolutionChange(uri) {
  // Parse solution/project files to detect new files or references
  const content = fs.readFileSync(uri.fsPath, 'utf8');
  
  // For .sln files
  if (uri.fsPath.endsWith('.sln')) {
    const projects = extractProjectReferences(content);
    updateWorkspace(projects);
  }
  
  // For .csproj files
  if (uri.fsPath.endsWith('.csproj')) {
    const references = extractAssemblyReferences(content);
    updateIntelliSense(references);
  }
  
  triggerUnityRefresh();
}
```

This approach monitors project file changes so when you add new assemblies or modify reference paths, the extension triggers appropriate refreshes in both VS Code's IntelliSense system and Unity's assembly management.

