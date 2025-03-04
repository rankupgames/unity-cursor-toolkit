# Unity Cursor Toolkit

An extension for Visual Studio Code and Cursor that provides enhanced Unity development tools, including hot reload functionality similar to JetBrains Rider's integration with Unity.

## Features

- Automatically refreshes Unity when C# scripts are modified in VS Code/Cursor
- Monitors solution and project files for changes
- Auto-detects Unity projects in your workspace
- Simple TCP-based communication with the Unity Editor

## Installation

### Quick Start
1. Clone this repository
2. Run `npm install` in the root directory
3. Run `npm run build` to build the extension

### Running and Debugging
1. Open this project in VS Code or Cursor
2. Press F5 to start debugging the extension in a new window
3. Open a Unity project in the new window to test the extension

### Unity Setup (User-Friendly Method)
1. While testing the extension, open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run "Unity Toolkit: Install Unity Script"
3. Select your Unity project if multiple are detected
4. The script will be automatically installed to your Unity project
5. Restart Unity if it's currently running

### Unity Setup (Manual Method)
1. Run `npm run install:unity` from the root directory and follow the prompts
2. Or manually copy `unity-cursor-toolkit/unity-assets/HotReloadHandler.cs` to your Unity project's `Assets/Editor` folder
3. Start or restart the Unity Editor

## Creating a Distributable Extension

To create a VSIX file that can be installed in VS Code or Cursor:

1. Update the publisher name in `unity-cursor-toolkit/package.json`
2. Run `npm run package` to create a .vsix file
3. The VSIX file will be generated in the unity-cursor-toolkit directory
4. To install the extension, run:
   - "Extensions: Install from VSIX..." from the Command Palette
   - Select the generated .vsix file

To publish to the VS Code Marketplace:
1. Create a publisher account on [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)
2. Get a Personal Access Token from Azure DevOps
3. Run `vsce login <publisher name>`
4. Run `npm run publish` to publish the extension

## Available Scripts

- `npm install` - Install dependencies for the root project
- `npm run install:extension` - Install dependencies for the VS Code extension
- `npm run build` - Build the VS Code extension
- `npm run watch` - Build the VS Code extension in watch mode
- `npm run install:unity` - Run the Unity script installer (command line)
- `npm run package` - Create a VSIX package for distribution
- `npm run publish` - Publish the extension to VS Code Marketplace

## Usage

When you open a Unity project in VS Code or Cursor, the hot reload functionality will automatically activate. You can manually enable or disable it using:

- `Unity Toolkit: Enable Hot Reload` - Command to enable hot reload
- `Unity Toolkit: Disable Hot Reload` - Command to disable hot reload
- `Unity Toolkit: Install Unity Script` - Install the required Unity script

In Unity, you can verify the hot reload server is running by checking the console for the message "Unity Hot Reload server listening on port 55500".

## How It Works

1. The extension watches for changes to C# files in your workspace
2. When a file is modified, the extension sends a message to Unity via TCP
3. The Unity Editor script receives the message and triggers a refresh of the Asset Database and script compilation
4. Your changes are immediately reflected in the Unity Editor

## Project Structure

- `unity-cursor-toolkit/` - VS Code extension code
  - `src/` - TypeScript source code
  - `unity-assets/` - Unity Editor scripts
- `.vscode/` - VS Code settings and launch configurations

## Requirements

- Visual Studio Code 1.60.0 or newer, or Cursor editor
- Unity 2018.4 or newer (full functionality requires Unity 2019.1+)
- Node.js and npm for development

## Planned Features

- Enhanced C# editing experience in VS Code/Cursor
- Better Unity project support beyond just hot reload
- Synchronization of settings between VS Code/Cursor and Unity
- Additional Unity-specific tools and commands

## Known Issues

- The connection might be temporarily lost when Unity is compiling scripts
- The hot reload does not apply to changes that require domain reload in Unity

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](LICENSE)
