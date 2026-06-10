import * as vscode from 'vscode';
import * as path from 'path';

export class RulesEngine {
    private static _instance: RulesEngine;
    private _rulesCache: string = '';
    private _disposables: vscode.Disposable[] = [];

    private constructor() {}

    public static getInstance(): RulesEngine {
        if (!RulesEngine._instance) {
            RulesEngine._instance = new RulesEngine();
        }
        return RulesEngine._instance;
    }

    public activate(context: vscode.ExtensionContext) {
        this.reloadRules();

        const watcher = vscode.workspace.createFileSystemWatcher('**/.flash/{FLASH.md,AGENTS.md,*.md}');
        
        watcher.onDidChange(() => this.reloadRules());
        watcher.onDidCreate(() => this.reloadRules());
        watcher.onDidDelete(() => this.reloadRules());

        this._disposables.push(watcher);
        context.subscriptions.push(this);
    }

    private async reloadRules() {
        let compiledRules = '';

        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return;

        for (const folder of folders) {
            const rulesPath = vscode.Uri.joinPath(folder.uri, '.flash');
            
            try {
                const stat = await vscode.workspace.fs.stat(rulesPath);
                if (stat.type === vscode.FileType.Directory) {
                    const entries = await vscode.workspace.fs.readDirectory(rulesPath);
                    for (const [name, type] of entries) {
                        if (type === vscode.FileType.File && name.endsWith('.md')) {
                            const fileUri = vscode.Uri.joinPath(rulesPath, name);
                            const content = await vscode.workspace.fs.readFile(fileUri);
                            compiledRules += `\n--- ${name} ---\n`;
                            compiledRules += Buffer.from(content).toString('utf8');
                            compiledRules += `\n`;
                        }
                    }
                }
            } catch (e) {
                // Ignore if .flash folder doesn't exist
            }
        }

        this._rulesCache = compiledRules.trim();
    }

    public getProjectRules(): string {
        if (!this._rulesCache) return '';

        return `<project_rules>\n${this._rulesCache}\n</project_rules>\n\nYou must strictly adhere to the <project_rules>. Violating these constraints constitutes a critical failure.`;
    }

    public dispose() {
        this._disposables.forEach(d => d.dispose());
    }
}
