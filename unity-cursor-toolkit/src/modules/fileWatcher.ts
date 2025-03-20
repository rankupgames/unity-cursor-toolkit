/**
 * File watcher module - Watches for file changes in Unity projects
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */
import * as vscode from 'vscode';
import { triggerUnityRefresh } from './socketConnection';

let fileWatcher: vscode.FileSystemWatcher | undefined;
let solutionWatcher: vscode.FileSystemWatcher | undefined;

/**
 * Enable file watching for Unity C# files and solution/project files
 */
export function enableFileWatchers() {
    // Watch for CS file changes
    fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.cs");
    fileWatcher.onDidChange(uri => {
        console.log(`File changed: ${uri.fsPath}`);
        triggerUnityRefresh();
    });

    // Watch for solution and project files
    solutionWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,csproj}");
    solutionWatcher.onDidChange(uri => {
        console.log(`Solution/project file changed: ${uri.fsPath}`);
        handleSolutionChange(uri);
    });
}

/**
 * Handle changes to solution or project files
 */
function handleSolutionChange(uri: vscode.Uri) {
    const filePath = uri.fsPath;

    // Parse solution/project files
    if (filePath.endsWith('.sln')) {
        console.log('Solution file changed, triggering Unity refresh');
    } else if (filePath.endsWith('.csproj')) {
        console.log('Project file changed, triggering Unity refresh');
    }

    // Trigger Unity refresh
    triggerUnityRefresh();
}

/**
 * Disable file watchers
 */
export function disableFileWatchers() {
    if (fileWatcher) {
        fileWatcher.dispose();
        fileWatcher = undefined;
    }

    if (solutionWatcher) {
        solutionWatcher.dispose();
        solutionWatcher = undefined;
    }
}