import * as vscode from 'vscode';
import * as path from 'path';

const SKIP = ['node_modules', '.git', 'dist', 'out', '__pycache__', '.vscode', 'venv', 'build', '.next'];
const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/__pycache__/**,**/venv/**,**/build/**,**/.next/**}';

export function getActiveFileContent(): { content: string; fileName: string; lang: string; relPath: string } | null {
    const e = vscode.window.activeTextEditor; if (!e) return null;
    const d = e.document; const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return { content: d.getText(), fileName: path.basename(d.fileName), lang: d.languageId, relPath: ws ? path.relative(ws, d.fileName) : d.fileName };
}

export function getSelectedText(): string | null {
    const e = vscode.window.activeTextEditor; if (!e || e.selection.isEmpty) return null;
    return e.document.getText(e.selection);
}

export async function getProjectTree(maxFiles = 200): Promise<string> {
    const ws = vscode.workspace.workspaceFolders; if (!ws) return 'No workspace.';
    const root = ws[0].uri;
    const files: string[] = [];
    let truncated = false;
    let total = 0;
    async function walk(dir: vscode.Uri, pfx: string) {
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { return; }
        // directories first, then files; each group alphabetical
        entries.sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] === vscode.FileType.Directory ? -1 : 1));
        for (const [name, type] of entries) {
            if (SKIP.includes(name) || name.startsWith('.')) continue;
            total++;
            if (files.length >= maxFiles) { truncated = true; continue; }
            files.push(pfx + (type === vscode.FileType.Directory ? '/ ' : '  ') + name);
            if (type === vscode.FileType.Directory) await walk(vscode.Uri.joinPath(dir, name), pfx + '  ');
        }
    }
    await walk(root, '');
    let out = 'Project: ' + ws[0].name + '\n' + files.join('\n');
    if (truncated) out += '\n(showing ' + maxFiles + '/' + total + ' entries — some omitted)';
    return out;
}

/** Full, uncapped list of workspace-relative file paths (for search & pickers). */
export async function getAllFiles(): Promise<string[]> {
    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB);
    // Shallower paths first (root files like package.json on top), then alphabetical.
    return uris.map(u => vscode.workspace.asRelativePath(u))
        .sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
}

/** Retrieve relative paths, contents, and languages for all currently visible editor documents. */
export function getVisibleFilesContent(): { content: string; relPath: string; lang: string }[] {
    const out: { content: string; relPath: string; lang: string }[] = [];
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const seen = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
        const d = editor.document;
        const fp = d.uri.fsPath;
        if (seen.has(fp)) continue;
        seen.add(fp);
        const rel = ws ? path.relative(ws, fp) : fp;
        // Skip large files (>30KB) or non-file documents to protect context tokens
        if (d.uri.scheme !== 'file' || d.getText().length > 30000) continue;
        out.push({ content: d.getText(), relPath: rel.replace(/\\/g, '/'), lang: d.languageId });
    }
    return out;
}
