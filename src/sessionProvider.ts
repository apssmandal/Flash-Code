import * as vscode from 'vscode';
import { sessionsKey, chatKey, summaryKey, lastKey } from './storage';

export interface Meta { id: string; title: string; date: string; count: number; }

/**
 * Per-workspace session store. No longer a TreeDataProvider — the sidebar is
 * now a webview (SidebarProvider). Exposes a change event so the sidebar can
 * re-render its list whenever sessions mutate.
 */
export class SessionProvider {
    private _ev = new vscode.EventEmitter<void>();
    /** Fires whenever the session list for the current workspace changes. */
    readonly onDidChange = this._ev.event;

    constructor(private ctx: vscode.ExtensionContext) {}

    list(): Meta[] { return this.ctx.globalState.get<Meta[]>(sessionsKey(), []); }

    save(m: Meta) {
        const l = this.list().filter(s => s.id !== m.id);
        l.unshift(m); if (l.length > 50) l.length = 50;
        this.ctx.globalState.update(sessionsKey(), l);
        this._ev.fire();
    }

    deleteSession(id: string) {
        const l = this.list().filter(s => s.id !== id);
        this.ctx.globalState.update(sessionsKey(), l);
        this.ctx.globalState.update(chatKey(id), undefined);
        this.ctx.globalState.update(summaryKey(id), undefined);
        if (this.ctx.globalState.get<string>(lastKey()) === id) {
            this.ctx.globalState.update(lastKey(), undefined);
        }
        this._ev.fire();
    }

    renameSession(id: string, newTitle: string) {
        const l = this.list();
        const s = l.find(x => x.id === id);
        if (s) { s.title = newTitle; this.ctx.globalState.update(sessionsKey(), l); this._ev.fire(); }
    }
}
