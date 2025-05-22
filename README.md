# Unity Cursor Toolkit

An extension for Visual Studio Code and Cursor that provides enhanced Unity development tools, including hot reload functionality and simplified project connection management.

> **Disclaimer:** This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

> **Developer's Note:** This extension is still in active development. We welcome contributions, feedback, and feature requests to help improve its functionality and stability.

## Features

- **Hot Reload**: Automatically refreshes Unity when C# scripts are modified (if Unity project is connected).
- **Simplified Connection Management**: Easy to connect, reload, and stop the connection to your Unity project via a status bar item and commands.
- **Project Detection**: Works with Unity projects in your workspace or allows selection of external folders.
- **Status Bar Integration**: A single status bar item provides context-aware actions and status display.
- **Efficient Communication**: Uses lightweight TCP-based protocol to communicate with the Unity Editor for hot reload.
- **Multi-Port Support**: Automatically finds available ports if the default is in use for the TCP connection.

## Future Planned Features

- **Unity Log Integration**: Direct access to Unity console logs within VS Code/Cursor
- **Enhanced Error Handling**: Improved error detection and reporting for Unity compilation issues
- **Custom Script Templates**: Create new scripts using configurable templates
- **Performance Metrics**: Monitor Unity Editor performance from within VS Code/Cursor
- **Multi-Project Support**: Better handling of workspaces with multiple Unity projects

### Quick Start (For Developers/Contributors)

1. Navigate to the `unity-cursor-toolkit` directory
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Run `npm run package` to create a VSIX file for installation.

## Installation

### VS Code/Cursor Extension

- Install from VS Code Marketplace (once published): Search for "Unity Cursor Toolkit"
- Or, build and install the `.vsix` file from the [GitHub repository](https://github.com/rankupgames/unity-cursor-toolkit) using the Quick Start instructions.

### Unity Script Installation

The necessary `HotReloadHandler.cs` script (for hot reload functionality) is automatically installed into your Unity project's `Assets/Editor` folder when you connect to a project for the first time using the "Unity Toolkit: Start/Attach to Project" command or by clicking the status bar item when no project is attached.

## Usage

The extension provides a status bar item at the bottom right of your VS Code/Cursor window to manage the connection to your Unity project:

- **Initial State (`$(plug) Unity: Attach Project`)**: Indicates no project is attached. Click to select your Unity project folder and initiate a connection. This step will also install/verify the `HotReloadHandler.cs` script in your project.
- **Connecting State (`$(sync~spin) Unity: [ProjectName]`)**: Shows that the extension is currently attempting to establish a connection with the selected Unity project.
- **Connected State (`$(circle-filled) Unity: [ProjectName]`)**: Displays the currently connected Unity project. Hovering over this item will show the port used for communication. Hot reload is active. Clicking the status bar item in this state may offer to reload the connection. For other actions like stopping, use the Command Palette.
- **Disconnected State (`$(debug-disconnect) Unity: [ProjectName]`)**: Indicates a previously known project is not currently connected, or the connection was lost/stopped. Click to attempt to re-establish the connection using the "Start/Attach to Project" logic.

### Command Palette

You can also use these commands from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P):

- **`Unity Toolkit: Start/Attach to Project`**: Initiates the process of selecting a Unity project (if one isn't already linked in the workspace session) and attempts to connect to it. This also handles the installation of the `HotReloadHandler.cs` script if needed.
- **`Unity Toolkit: Reload Connection`**: If a Unity project is linked, this command will stop any active connection and attempt to re-establish it. This is useful if the connection seems unresponsive or if Unity was restarted.
- **`Unity Toolkit: Stop Connection`**: Disconnects from the currently attached Unity project and deactivates hot reload features. The status bar will update to show the project as disconnected.

In Unity, you can verify the hot reload server is running by checking the console for a message like "Unity Hot Reload server listening on port [port_number]".

## How It Works (Hot Reload)

1. The extension, when connected to a Unity project, watches for changes to C# files in your workspace.
2. When a file is modified and saved, the extension sends a message to the `HotReloadHandler.cs` script running in the Unity Editor via TCP.
3. The `HotReloadHandler.cs` script receives the message and triggers a refresh of the Unity Asset Database and script compilation.
4. Your C# changes are then reflected in the Unity Editor, often without requiring a full domain reload.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Rank Up Games LLC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Release Notes

### 0.1.30120250521 (Current)

- **Major Command Refactor**: Introduced three core commands: `Start/Attach to Project`, `Reload Connection`, and `Stop Connection`.
- Simplified status bar interaction: Single item dynamically updates text, icon, and tooltip based on connection state.
- Removed previous individual commands for enabling/disabling hot reload, force reload, etc. from the command palette.
- Status bar now shows connection port in tooltip and uses a green dot icon (`$(circle-filled)`) for active connection.
- Improved error handling for connection attempts to reduce pop-up spam for background retries.
- Updated README to reflect new workflow and commands.

### Previous Versions

Information on older versions can be found in commit history or previous tags.
(Details of 0.1.20250320 and 0.1.0 were in the other README version, you might want to merge those here if important)
