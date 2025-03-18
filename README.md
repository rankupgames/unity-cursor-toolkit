# Unity Cursor Toolkit

An extension for Visual Studio Code and Cursor that provides enhanced Unity development tools, including hot reload functionality similar to JetBrains Rider's integration with Unity.

> **Disclaimer:** This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

> **Developer's Note:** This extension is still in active development. We welcome contributions, feedback, and feature requests to help improve its functionality and stability.

## Features

- **Hot Reload**: Automatically refreshes Unity when C# scripts are modified in VS Code/Cursor
- **Project Monitoring**: Tracks changes to solution and project files for seamless integration
- **Auto-Detection**: Automatically detects Unity projects in your workspace without manual configuration
- **Efficient Communication**: Uses lightweight TCP-based protocol to communicate with the Unity Editor
- **Accessible Controls**: Status bar buttons for quick access to all toolkit functionality

## Future Planned Features

- **Unity Log Integration**: Direct access to Unity console logs within VS Code/Cursor
- **Enhanced Error Handling**: Improved error detection and reporting for Unity compilation issues
- **Custom Script Templates**: Create new scripts using configurable templates
- **Performance Metrics**: Monitor Unity Editor performance from within VS Code/Cursor
- **Multi-Project Support**: Better handling of workspaces with multiple Unity projects

### Quick Start
1. Navigate to the `unity-cursor-toolkit` directory
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Run `npm run package` to create a VSIX file

## Usage

When you open a Unity project in VS Code or Cursor, the hot reload functionality will automatically activate.

### Status Bar Controls

The extension adds buttons to the editor's status bar for quick access:
- Hot Reload toggle button (On/Off)
- Select Unity Project button
- Install Unity Script button

### Command Palette

You can also use these commands from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P):
- `Unity Toolkit: Enable Hot Reload` - Command to enable hot reload
- `Unity Toolkit: Disable Hot Reload` - Command to disable hot reload
- `Unity Toolkit: Toggle Hot Reload` - Command to toggle hot reload
- `Unity Toolkit: Install Unity Script` - Install the required Unity script
- `Unity Toolkit: Select Unity Project` - Browse for a Unity project

In Unity, you can verify the hot reload server is running by checking the console for the message "Unity Hot Reload server listening on port 55500".

## How It Works

1. The extension watches for changes to C# files in your workspace
2. When a file is modified, the extension sends a message to Unity via TCP
3. The Unity Editor script receives the message and triggers a refresh of the Asset Database and script compilation
4. Your changes are immediately reflected in the Unity Editor

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Rank Up Games LLC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
