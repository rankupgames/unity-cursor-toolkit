# Unity Cursor Toolkit

![Unity Cursor Toolkit Icon](icon.svg)

This extension brings enhanced Unity development tools to VS Code and Cursor, including hot reload functionality similar to JetBrains Rider's integration with Unity. Edit your scripts in VS Code/Cursor and see the changes immediately in the Unity Editor without manual refresh.

## Features

- **Hot Reload**: Changes to C# scripts are automatically refreshed in Unity
- **Solution Monitoring**: Detects changes to Unity solution and project files
- **Project Auto-Detection**: Automatically activates when a Unity project is opened
- **Easy Installation**: VS Code command to install the Unity script directly from the editor

## Installation

### 1. VS Code/Cursor Extension

#### From VS Code Marketplace
1. Open VS Code or Cursor
2. Go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Unity Cursor Toolkit"
4. Click Install

#### Manual Installation
1. Download the latest .vsix file from the [releases page](https://github.com/username/better-unity-rideralt/releases)
2. In VS Code/Cursor, open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
3. Run "Extensions: Install from VSIX..." and select the downloaded file

### 2. Unity Script Installation

After installing the VS Code extension, you need to install the Unity script component:

1. Open your Unity project in VS Code/Cursor
2. Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
3. Run "Unity Toolkit: Install Unity Script"
4. If multiple Unity projects are detected, select the target project
5. Restart Unity if it's currently running

## Usage

The extension automatically activates when a Unity project is detected.

### Commands

- **Unity Toolkit: Enable Hot Reload** - Enable hot reload functionality
- **Unity Toolkit: Disable Hot Reload** - Disable hot reload functionality
- **Unity Toolkit: Install Unity Script** - Install the required Unity script

### Verification

In Unity, check the console for the message "Unity Hot Reload server listening on port 55500" to confirm everything is working properly.

## How It Works

1. The extension watches for changes to C# files in your workspace
2. When a file is modified, the extension sends a message to Unity via TCP
3. The Unity Editor script receives the message and triggers a refresh of the Asset Database and script compilation
4. Your changes are immediately reflected in the Unity Editor

## Requirements

- Visual Studio Code 1.60.0 or newer, or Cursor editor
- Unity 2018.4 or newer (full functionality requires Unity 2019.1+)
- .NET Framework or Mono (for Unity script compilation)

## Troubleshooting

### No connection to Unity

If the extension can't connect to Unity, check:
1. Unity is running and the project is open
2. The Hot Reload script is installed in your Unity project
3. No firewall is blocking port 55500
4. Restart both VS Code/Cursor and Unity

### Script not working

If the hot reload doesn't work:
1. Check Unity console for errors
2. Make sure you've installed the Unity script correctly
3. Try running "Unity Toolkit: Install Unity Script" command again
4. Verify there are no compilation errors in your Unity project

## Known Issues

- The connection might be temporarily lost when Unity is compiling scripts
- Hot reload does not apply to changes that require domain reload in Unity

## Contributing

Pull requests are welcome! See the [contribution guidelines](CONTRIBUTING.md) for more information.

## License

[MIT](LICENSE)

## Release Notes

### 0.1.0
- Initial release
- Hot reload functionality
- Unity script installation command 