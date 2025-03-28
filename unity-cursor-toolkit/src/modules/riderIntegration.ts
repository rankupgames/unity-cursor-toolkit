import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { RiderBackendManager } from './riderBackend';

export class RiderBackendConnector {
    private connection: net.Socket | null = null;
    private port: number = 8007; // Rider's default backend port
    private isConnected: boolean = false;
    private statusBarItem: vscode.StatusBarItem;
    private backendManager: RiderBackendManager;

    constructor() {
        // Create status bar item for Rider integration
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
        this.statusBarItem.command = 'unity-cursor-toolkit.toggleRiderIntegration';
        this.updateStatusBarItem();

        // Initialize backend manager
        this.backendManager = new RiderBackendManager();
    }

    public async connect(): Promise<boolean> {
        if (this.isConnected) {
            return true;
        }

        try {
            // First, start the Rider backend process
            const backendStarted = await this.backendManager.start();
            if (!backendStarted) {
                throw new Error('Failed to start Rider backend process');
            }

            // Then establish the connection
            this.connection = new net.Socket();

            // Set up connection event handlers
            this.connection.on('connect', () => {
                this.isConnected = true;
                this.updateStatusBarItem();
                vscode.window.showInformationMessage('Connected to Rider backend');
            });

            this.connection.on('error', (error) => {
                this.isConnected = false;
                this.updateStatusBarItem();
                vscode.window.showErrorMessage(`Rider connection error: ${error.message}`);
            });

            this.connection.on('close', () => {
                this.isConnected = false;
                this.updateStatusBarItem();
                vscode.window.showInformationMessage('Disconnected from Rider backend');
            });

            // Attempt to connect
            await new Promise<void>((resolve, reject) => {
                if (!this.connection) {
                    reject(new Error('Connection not initialized'));
                    return;
                }

                this.connection.connect(this.port, 'localhost', () => {
                    resolve();
                });
            });

            return true;
        } catch (error) {
            this.isConnected = false;
            this.updateStatusBarItem();
            vscode.window.showErrorMessage(`Failed to connect to Rider backend: ${error}`);
            return false;
        }
    }

    public disconnect(): void {
        if (this.connection) {
            this.connection.end();
            this.connection = null;
            this.isConnected = false;
            this.updateStatusBarItem();
        }

        // Stop the backend process
        this.backendManager.stop();
    }

    public isRiderBackendConnected(): boolean {
        return this.isConnected && this.backendManager.isBackendRunning();
    }

    private updateStatusBarItem(): void {
        if (this.isConnected) {
            this.statusBarItem.text = "$(check) Rider: Connected";
            this.statusBarItem.tooltip = "Rider C# intelligence is active. Click to disconnect.";
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.activeBackground');
        } else {
            this.statusBarItem.text = "$(close) Rider: Disconnected";
            this.statusBarItem.tooltip = "Rider C# intelligence is inactive. Click to connect.";
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        this.statusBarItem.show();
    }

    public dispose(): void {
        this.disconnect();
        this.statusBarItem.dispose();
    }
}