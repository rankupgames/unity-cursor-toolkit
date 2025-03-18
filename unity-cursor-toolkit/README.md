# Unity Cursor Toolkit

![Unity Cursor Toolkit Icon](icon.png)

A VS Code/Cursor extension providing hot reload functionality for Unity projects. Edit your C# scripts and see changes immediately reflected in Unity without manual refresh.

> **Disclaimer:** This extension is not affiliated with, endorsed by, or an official product of Unity Technologies. Unity and the Unity logo are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and elsewhere.

> **Developer's Note:** This extension is still in active development. We welcome contributions, feedback, and feature requests to help improve its functionality and stability.

## Features

- **Hot Reload** - Automatic refresh of Unity when scripts are modified
- **Project Detection** - Works with Unity projects in your workspace or external folders
- **Status Bar Controls** - Quick access buttons for all functionality
- **Multi-Port Support** - Automatically finds available ports if default is in use

## Installation

### VS Code/Cursor Extension
- Install from VS Code Marketplace: Search for "Unity Cursor Toolkit"

### Unity Script
- Run "Unity Toolkit: Install Unity Script" from the Command Palette
- Or select an external project with "Unity Toolkit: Select Unity Project"

## Usage

The extension activates automatically with Unity projects. Use the status bar buttons:
- **Hot Reload: On/Off** - Toggle hot reload functionality
- **Select Unity Project** - Choose an external Unity project
- **Install Unity Script** - Install the required Unity script

## Verification

Check the Unity console for "Unity Hot Reload server listening on port 55500" to confirm it's working.

## Troubleshooting

### No connection to Unity
- Ensure Unity is running with the project open
- Verify the Hot Reload script is installed
- Check for firewall blocking port 55500
- Restart VS Code/Cursor and Unity

### Script not working
- Check Unity console for errors
- Reinstall the Unity script
- Verify no compilation errors in your project

## Known Issues
- Connection may be lost temporarily during script compilation
- Hot reload doesn't apply to changes requiring domain reload

## License

MIT License - Copyright (c) 2025 Rank Up Games LLC

## Release Notes

### 0.1.20250320
- Updated GitHub repository links
- Added multi-port support to handle socket binding issues
- Added disclaimer about unofficial status
- Improved error handling
- Simplified documentation

### 0.1.0
- Initial release
- Hot reload functionality
- Unity script installation command
- Status bar controls 