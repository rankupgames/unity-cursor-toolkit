import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as fs from 'fs';

export class RiderBackendManager {
    private process: cp.ChildProcess | null = null;
    private port: number = 8007;
    private config: vscode.WorkspaceConfiguration;
    private isRunning: boolean = false;

    constructor() {
        this.config = vscode.workspace.getConfiguration('unity-cursor-toolkit');
    }

    public async start(): Promise<boolean> {
        if (this.isRunning) {
            return true;
        }

        try {
            const riderPath = this.getRiderPath();
            if (!riderPath) {
                throw new Error('Rider installation path not found. Please set it in settings.');
            }

            // Construct the path to the ReSharper host executable
            const hostPath = this.getReSharperHostPath(riderPath);
            if (!fs.existsSync(hostPath)) {
                throw new Error(`ReSharper host not found at: ${hostPath}`);
            }

            // Copy runtime config file to the correct location
            const runtimeConfigSource = path.join(riderPath, 'Contents', 'lib', 'ReSharperHost', 'Rider.Backend.netcore.runtimeconfig.json');
            const runtimeConfigTarget = path.join(riderPath, 'Contents', 'lib', 'ReSharperHost', 'Rider.Backend.runtimeconfig.json');

            if (fs.existsSync(runtimeConfigSource)) {
                fs.copyFileSync(runtimeConfigSource, runtimeConfigTarget);
            }

            // Copy libhostpolicy.dylib to the correct location
            const arch = os.arch();
            const archFolder = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
            const hostPolicySource = path.join(riderPath, 'Contents', 'lib', 'ReSharperHost', archFolder, 'dotnet', 'shared', 'Microsoft.NETCore.App', '8.0.11', 'libhostpolicy.dylib');
            const hostPolicyTarget = path.join(riderPath, 'Contents', 'lib', 'ReSharperHost', 'macos-arm64', 'dotnet', 'libhostpolicy.dylib');

            // Ensure the target directory exists
            const targetDir = path.dirname(hostPolicyTarget);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (fs.existsSync(hostPolicySource)) {
                fs.copyFileSync(hostPolicySource, hostPolicyTarget);
            }

            // Start the ReSharper host process
            const platform = os.platform();
            const args = [
                '--port=' + this.port,
                '--headless',
                '--no-splash',
                '--no-window'
            ];

            // Add platform-specific arguments
            if (platform === 'darwin') {
                args.push('--macos');
            }

            this.process = cp.spawn(hostPath, args);

            // Set up process event handlers
            this.process.stdout?.on('data', (data) => {
                vscode.window.showInformationMessage(`Rider backend: ${data}`);
            });

            this.process.stderr?.on('data', (data) => {
                vscode.window.showErrorMessage(`Rider backend error: ${data}`);
            });

            this.process.on('close', (code) => {
                this.isRunning = false;
                vscode.window.showInformationMessage(`Rider backend exited with code ${code}`);
            });

            this.isRunning = true;
            return true;
        } catch (error) {
            this.isRunning = false;
            vscode.window.showErrorMessage(`Failed to start Rider backend: ${error}`);
            return false;
        }
    }

    public stop(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.isRunning = false;
        }
    }

    public isBackendRunning(): boolean {
        return this.isRunning;
    }

    private getRiderPath(): string | undefined {
        // First try to get from settings
        const configuredPath = this.config.get<string>('riderPath');
        if (configuredPath) {
            return configuredPath;
        }

        // Try to find Rider installation in default locations
        const defaultPaths = this.getDefaultRiderPaths();
        for (const path of defaultPaths) {
            if (fs.existsSync(path)) {
                return path;
            }
        }

        return undefined;
    }

    private getReSharperHostPath(riderPath: string): string {
        const platform = os.platform();
        let hostPath: string;

        switch (platform) {
            case 'darwin': // macOS
                // Determine the correct architecture folder
                const arch = os.arch();
                const archFolder = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
                hostPath = path.join(riderPath, 'Contents', 'lib', 'ReSharperHost', archFolder, 'Rider.Backend');
                break;
            case 'win32': // Windows
                hostPath = path.join(riderPath, 'lib', 'ReSharperHost', 'JetBrains.ReSharper.Host.exe');
                break;
            case 'linux': // Linux
                hostPath = path.join(riderPath, 'lib', 'ReSharperHost', 'JetBrains.ReSharper.Host');
                break;
            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }

        return hostPath;
    }

    private getDefaultRiderPaths(): string[] {
        const platform = os.platform();
        const paths: string[] = [];

        switch (platform) {
            case 'darwin': // macOS
                paths.push(
                    path.join(os.homedir(), 'Applications', 'Rider.app'),
                    '/Applications/Rider.app'
                );
                break;
            case 'win32': // Windows
                paths.push(
                    'C:\\Program Files\\JetBrains\\Rider',
                    'C:\\Program Files (x86)\\JetBrains\\Rider'
                );
                break;
            case 'linux': // Linux
                paths.push(
                    '/opt/jetbrains/rider',
                    path.join(os.homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'apps', 'Rider')
                );
                break;
        }

        return paths;
    }
}