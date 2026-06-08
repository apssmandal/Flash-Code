import * as vscode from 'vscode';

/**
 * Per-workspace storage scoping. All session data is keyed by the active
 * workspace folder so chats from one project never leak into another.
 */

function hash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(36);
}

/** Stable key for the current workspace (or 'no-folder' when none is open). */
export function wsKey(): string {
    const f = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    return f ? hash(f) : 'no-folder';
}

export function sessionsKey(): string { return 'fc.sessions::' + wsKey(); }
export function chatKey(id: string): string { return 'fc.chat::' + wsKey() + '::' + id; }
export function summaryKey(id: string): string { return 'fc.summary::' + wsKey() + '::' + id; }
export function lastKey(): string { return 'fc.last::' + wsKey(); }

/**
 * Migrates workspace-scoped legacy 'ca.' sessions/chats to new 'fc.' keys.
 */
export function migrateLegacy(ctx: vscode.ExtensionContext) {
    if (ctx.globalState.get<boolean>('fc.migrated.v5')) return;
    const legacySessionsKey = 'ca.sessions::' + wsKey();
    const legacy = ctx.globalState.get<any[]>(legacySessionsKey);
    if (legacy && legacy.length) {
        const target = sessionsKey();
        const existing = ctx.globalState.get<any[]>(target, []);
        ctx.globalState.update(target, [...existing, ...legacy]);
        // Move chat details and summaries.
        for (const s of legacy) {
            const oldChat = 'ca.chat::' + wsKey() + '::' + s.id;
            const chatBlob = ctx.globalState.get<any>(oldChat);
            if (chatBlob) ctx.globalState.update(chatKey(s.id), chatBlob);

            const oldSummary = 'ca.summary::' + wsKey() + '::' + s.id;
            const summaryBlob = ctx.globalState.get<any>(oldSummary);
            if (summaryBlob) ctx.globalState.update(summaryKey(s.id), summaryBlob);
        }
    }
    ctx.globalState.update('fc.migrated.v5', true);
}
