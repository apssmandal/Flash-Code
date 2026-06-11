/** Cross-webview signal: fires when the saved-session index changes so the
 * sidebar and chat panel stay in sync without sharing a SessionManager. */
import * as vscode from 'vscode';

export const sessionEvents = new vscode.EventEmitter<void>();
