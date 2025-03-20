/**
 * Socket connection module - Manages connections to Unity for hot reloading
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */
import * as vscode from 'vscode';
import * as net from 'net';

// Default port for communication with Unity Editor
const DEFAULT_UNITY_HOT_RELOAD_PORT = 55500;
// Ports to try in sequence if the default port is unavailable
const ALTERNATIVE_PORTS = [55500, 55501, 55502, 55503, 55504];
let currentPort = DEFAULT_UNITY_HOT_RELOAD_PORT;
let socketClient: net.Socket | undefined;

/**
 * Connect to Unity via socket
 */
export function connectToUnity() {
    if (socketClient) {
        try {
            socketClient.destroy();
        } catch (e) {
            console.error('Error destroying existing socket:', e);
        }
        socketClient = undefined;
    }

    // Try each port in sequence
    tryConnectToPort(0);
}

/**
 * Try connecting to Unity on a specific port
 */
function tryConnectToPort(portIndex: number) {
    if (portIndex >= ALTERNATIVE_PORTS.length) {
        console.error('Failed to connect to Unity on any port');
        vscode.window.showErrorMessage('Failed to connect to Unity. Make sure Unity is running and the Hot Reload script is installed.');
        return;
    }

    const port = ALTERNATIVE_PORTS[portIndex];
    console.log(`Trying to connect to Unity on port ${port}...`);

    socketClient = new net.Socket();

    socketClient.on('error', (error) => {
        console.log(`Connection error on port ${port}: ${error.message}`);
        socketClient?.destroy();
        socketClient = undefined;

        // Try the next port
        tryConnectToPort(portIndex + 1);
    });

    socketClient.on('close', () => {
        console.log('Socket connection closed');
        socketClient = undefined;
        // Try to reconnect after a delay if hot reload is still enabled
        setTimeout(() => {
            if (isSocketNeeded()) {
                connectToUnity();
            }
        }, 5000);
    });

    // Set a connection timeout to try other ports
    socketClient.setTimeout(2000);
    socketClient.on('timeout', () => {
        console.log(`Connection timeout on port ${port}`);
        socketClient?.destroy();
        socketClient = undefined;

        // Try the next port
        tryConnectToPort(portIndex + 1);
    });

    socketClient.connect(port, 'localhost', () => {
        console.log(`Connected to Unity Editor on port ${port}`);
        currentPort = port;

        // Reset the timeout once connected
        socketClient?.setTimeout(0);

        // Update status message
        vscode.window.setStatusBarMessage(`Connected to Unity on port ${port}`, 5000);
    });
}

/**
 * Check if socket is still needed (to be implemented in main module)
 */
function isSocketNeeded(): boolean {
    // This will be set from outside
    return true;
}

/**
 * Trigger Unity to refresh scripts
 */
export function triggerUnityRefresh() {
    if (!socketClient || socketClient.destroyed) {
        connectToUnity();
        return;
    }

    try {
        socketClient.write(JSON.stringify({
            command: 'refresh',
            timestamp: new Date().getTime()
        }));
    } catch (error) {
        console.error('Error sending refresh command:', error);
        connectToUnity();
    }
}

/**
 * Close socket connection
 */
export function closeConnection() {
    if (socketClient) {
        socketClient.end();
        socketClient = undefined;
    }
}

/**
 * Update the socket connection status check function
 */
export function setSocketNeededCallback(callback: () => boolean) {
    // @ts-ignore - Override the function
    isSocketNeeded = callback;
}