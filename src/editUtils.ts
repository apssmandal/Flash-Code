/**
 * Parse and apply LLM file edits.
 * - <edit path="…"> with one or more SEARCH/REPLACE pairs → targeted edits
 * - <create path="…">full content</create>                → new/replace whole file
 * - ```lang:path fenced block (fallback)                   → treated as full replace
 * The model emits only changed regions for existing files (token saving); the
 * extension applies them and the diff is computed separately (diffUtils).
 */

export interface SR { search: string; replace: string; }
export interface FileEdit { path: string; pairs: SR[]; full?: string; }

const EDIT_RE = /<edit\s+path="([^"]+)"\s*>([\s\S]*?)<\/edit>/g;
const CREATE_RE = /<create\s+path="([^"]+)"\s*>([\s\S]*?)<\/create>/g;
const SR_RE = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>>\s*REPLACE/g;
// fallback: ```lang:path\n…\n```
const FENCE_PATH_RE = /```[\w.+-]*:([^\s`]+)\n([\s\S]*?)```/g;

function stripTrailingNl(s: string): string { return s.replace(/\n$/, ''); }

export function parseEdits(text: string): FileEdit[] {
    const out: FileEdit[] = [];
    const seenCreate = new Set<string>();
    let m: RegExpExecArray | null;

    CREATE_RE.lastIndex = 0;
    while ((m = CREATE_RE.exec(text)) !== null) {
        out.push({ path: m[1].trim(), pairs: [], full: stripTrailingNl(m[2]) });
        seenCreate.add(m[1].trim());
    }

    EDIT_RE.lastIndex = 0;
    while ((m = EDIT_RE.exec(text)) !== null) {
        const path = m[1].trim();
        const body = m[2];
        const pairs: SR[] = [];
        let s: RegExpExecArray | null; SR_RE.lastIndex = 0;
        while ((s = SR_RE.exec(body)) !== null) pairs.push({ search: s[1], replace: s[2] });
        if (pairs.length) out.push({ path, pairs });
    }

    // fallback fenced blocks with a path — only if not already covered
    FENCE_PATH_RE.lastIndex = 0;
    while ((m = FENCE_PATH_RE.exec(text)) !== null) {
        const path = m[1].trim();
        if (seenCreate.has(path) || out.some(e => e.path === path)) continue;
        out.push({ path, pairs: [], full: stripTrailingNl(m[2]) });
    }
    return out;
}

/** Apply one SEARCH/REPLACE: exact match first, then a whitespace-tolerant unique match. */
function applyOne(content: string, sr: SR): { content: string; ok: boolean } {
    const { search, replace } = sr;
    if (search === '') return { content: content, ok: false };
    const first = content.indexOf(search);
    if (first !== -1 && content.indexOf(search, first + 1) === -1) {
        return { content: content.slice(0, first) + replace + content.slice(first + search.length), ok: true };
    }
    // Fallback: replace all whitespace with a single space for match comparison
    const norm = (s: string) => s.replace(/\s+/g, ' ');
    const nSearch = norm(search);
    const cLines = content.split('\n');
    const sLines = search.split('\n');
    let hitIdx = -1, hits = 0;
    for (let i = 0; i + sLines.length <= cLines.length; i++) {
        const window = cLines.slice(i, i + sLines.length).join('\n');
        if (norm(window) === nSearch) { hits++; hitIdx = i; }
    }
    if (hits === 1) {
        const before = cLines.slice(0, hitIdx).join('\n');
        const after = cLines.slice(hitIdx + sLines.length).join('\n');
        return { content: [before, replace, after].filter((x, i) => !(x === '' && i !== 1)).join('\n'), ok: true };
    }
    return { content, ok: false };
}

export function applyEdits(old: string, e: FileEdit): { content: string; failures: string[] } {
    if (e.full !== undefined) return { content: e.full, failures: [] };
    let content = old;
    const failures: string[] = [];
    for (const sr of e.pairs) {
        const r = applyOne(content, sr);
        if (r.ok) content = r.content;
        else failures.push(sr.search.split('\n')[0].slice(0, 80));
    }
    return { content, failures };
}
