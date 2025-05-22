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
let isConnecting = false; // Prevent multiple concurrent connection attempts

/**
 * Connect to Unity via socket
 * @param isInitialAttempt If true, will show error message if all ports fail.
 * @returns A promise that resolves with the port number on success, or null on failure.
 */
export function connectToUnity(isInitialAttempt: boolean = false): Promise<number | null> {
    if (isConnecting && !isInitialAttempt) {
        console.log('[SocketConnection] Already attempting to connect, new auto-attempt skipped.');
        return Promise.resolve(null); // Or reject, depending on desired behavior for concurrent calls
    }
    isConnecting = true;

    return new Promise((resolve) => {
        if (socketClient && !socketClient.destroyed) {
            try {
                socketClient.destroy();
            } catch (e) {
                console.error('[SocketConnection] Error destroying existing socket:', e);
            }
            socketClient = undefined;
        }
        tryConnectToPort(0, isInitialAttempt, resolve);
    });
}

/**
 * Try connecting to Unity on a specific port
 */
function tryConnectToPort(portIndex: number, isInitialAttempt: boolean, resolve: (port: number | null) => void) {
    if (portIndex >= ALTERNATIVE_PORTS.length) {
        console.error('[SocketConnection] Failed to connect to Unity on any port');
        if (isInitialAttempt) {
            vscode.window.showErrorMessage('Failed to connect to Unity. Make sure Unity is running and the Hot Reload script is installed.');
        }
        isConnecting = false;
        resolve(null);
        return;
    }

    const port = ALTERNATIVE_PORTS[portIndex];
    console.log(`[SocketConnection] Trying to connect to Unity on port ${port}...`);

    socketClient = new net.Socket();

    const connectionFailed = () => {
        socketClient?.destroy();
        socketClient = undefined;
        // Try the next port
        tryConnectToPort(portIndex + 1, isInitialAttempt, resolve);
    };

    socketClient.on('error', (error) => {
        console.log(`[SocketConnection] Connection error on port ${port}: ${error.message}`);
        connectionFailed();
    });

    socketClient.on('close', () => {
        console.log('[SocketConnection] Socket connection closed');
        isConnecting = false; // Allow new connections
        // socketClient = undefined; // Already handled in connectionFailed or success
        // Try to reconnect after a delay if hot reload is still enabled
        setTimeout(() => {
            if (isSocketNeeded() && (!socketClient || socketClient.destroyed)) {
                console.log('[SocketConnection] Attempting to reconnect due to close event.');
                connectToUnity(false).then(reconnectedPort => {
                    if (reconnectedPort) {
                        vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', reconnectedPort, true);
                    } else {
                        vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', null, false);
                    }
                });
            }
        }, 5000);
    });

    // Set a connection timeout to try other ports
    socketClient.setTimeout(2000);
    socketClient.on('timeout', () => {
        console.log(`[SocketConnection] Connection timeout on port ${port}`);
        connectionFailed();
    });

    socketClient.connect(port, 'localhost', () => {
        console.log(`[SocketConnection] Connected to Unity Editor on port ${port}`);
        currentPort = port;
        isConnecting = false;

        // Reset the timeout once connected
        socketClient?.setTimeout(0);

        // Don't use vscode.window.setStatusBarMessage here.
        // Resolve the promise with the port number.
        resolve(port);
    });
}

/**
 * Check if socket is still needed (to be implemented in main module)
 */
let _isSocketNeededCallback: () => boolean = () => true; // Default implementation

function isSocketNeeded(): boolean {
    return _isSocketNeededCallback();
}

/**
 * Trigger Unity to refresh scripts
 */
export function triggerUnityRefresh() {
    if (!socketClient || socketClient.destroyed) {
        console.log('[SocketConnection] No active connection to trigger refresh. Attempting to connect.');
        connectToUnity(false).then(port => { // isInitialAttempt = false for auto-actions
            if (port) {
                vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', port, true);
                triggerUnityRefresh(); // Retry refresh after successful connection
            } else {
                 vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', null, false);
                console.warn('[SocketConnection] Cannot trigger refresh, connection failed.');
            }
        });
        return;
    }

    try {
        console.log('[SocketConnection] Sending refresh command to Unity.');
        socketClient.write(JSON.stringify({
            command: 'refresh',
            timestamp: new Date().getTime()
        }));
    } catch (error) {
        console.error('[SocketConnection] Error sending refresh command:', error);
        // Attempt to reconnect and then potentially retry or notify user
        connectToUnity(false).then(port => {
            if (port) {
                vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', port, true);
            } else {
                vscode.commands.executeCommand('unity-cursor-toolkit.reportConnectionStatus', null, false);
            }
        });
    }
}

/**
 * Close socket connection
 */
export function closeConnection() {
    isConnecting = false; // Stop any ongoing connection attempts
    if (socketClient) {
        console.log('[SocketConnection] Closing socket connection.');
        socketClient.destroy(); // Use destroy for immediate effect
        socketClient = undefined;
    }
}

/**
 * Update the socket connection status check function
 */
export function setSocketNeededCallback(callback: () => boolean) {
    _isSocketNeededCallback = callback;
}