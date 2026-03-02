/**
 * Console Bridge module - Receives Unity console output and opens a Cursor chat
 *
 * Handles the "consoleToCursor" command from the Unity Editor TCP bridge.
 * Copies console output to clipboard and attempts to open a new AI chat in Cursor.
 *
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 */
import * as vscode from 'vscode';
import { setIncomingMessageHandler } from './socketConnection';

const CHAT_COMMANDS = [
    'workbench.action.chat.newChat',
    'aichat.newchataction',
    'workbench.action.chat.open',
];

export function initializeConsoleBridge(): void {
    setIncomingMessageHandler(handleUnityMessage);
}

function handleUnityMessage(command: string, payload: Record<string, unknown>): void {
    if (command === 'consoleToCursor') {
        const content = payload.content as string | undefined;
        const count = payload.entryCount as number | undefined;
        if (content) {
            openChatWithContent(content, count ?? 0);
        }
    }
}

async function openChatWithContent(content: string, entryCount: number): Promise<void> {
    await vscode.env.clipboard.writeText(content);

    let chatOpened = false;
    for (const cmd of CHAT_COMMANDS) {
        try {
            await vscode.commands.executeCommand(cmd);
            chatOpened = true;
            break;
        } catch {
            continue;
        }
    }

    const label = entryCount > 0 ? `${entryCount} entries` : 'Console output';
    if (chatOpened) {
        vscode.window.showInformationMessage(
            `${label} copied to clipboard. Paste (Cmd/Ctrl+V) into the chat to start debugging.`
        );
    } else {
        vscode.window.showInformationMessage(
            `${label} copied to clipboard. Open a new Cursor chat and paste to start debugging.`
        );
    }
}
