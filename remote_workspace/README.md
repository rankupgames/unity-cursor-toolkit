# Unity VDD Shell Workspace

Run `Unity Shell: Init Manifest` from VS Code/Cursor to create the local `unity-shell.json` manifest from the checked-in example. The real manifest is ignored because it contains machine-specific SSH targets and remote paths.

The MVP assumes a Windows host with a VDD monitor, FFmpeg, a Unity Windows Player build, and the remote PowerShell sidecar copied to the manifest's `remoteSidecarPath`.
