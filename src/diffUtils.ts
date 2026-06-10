/**
 * Pure line-diff utility producing paired rows for a side-by-side view
 * (old on the left, new on the right). LCS dynamic programming for normal
 * files; a cheap fallback for very large files to avoid huge DP tables.
 */

export interface DiffRow {
    left?: { n: number; text: string };
    right?: { n: number; text: string };
    type: 'same' | 'add' | 'remove' | 'gap';
}

export function hasDiff(a: string, b: string): boolean { return a !== b; }

const MAX_LCS_LINES = 500;

export function computeSideBySide(oldText: string, newText: string, ctx = 3): DiffRow[] {
    const o = oldText.length ? oldText.split('\n') : [];
    const n = newText.length ? newText.split('\n') : [];

    let rows: DiffRow[];
    if (o.length > MAX_LCS_LINES || n.length > MAX_LCS_LINES) {
        rows = blockDiff(o, n);
    } else {
        rows = lcsDiff(o, n);
    }
    return collapse(rows, ctx);
}

function lcsDiff(o: string[], n: string[]): DiffRow[] {
    const m = o.length, k = n.length;
    // dp[i][j] = LCS length of o[i..], n[j..]
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = k - 1; j >= 0; j--) {
            dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const rows: DiffRow[] = [];
    let i = 0, j = 0;
    while (i < m && j < k) {
        if (o[i] === n[j]) {
            rows.push({ type: 'same', left: { n: i + 1, text: o[i] }, right: { n: j + 1, text: n[j] } });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            rows.push({ type: 'remove', left: { n: i + 1, text: o[i] } });
            i++;
        } else {
            rows.push({ type: 'add', right: { n: j + 1, text: n[j] } });
            j++;
        }
    }
    while (i < m) { rows.push({ type: 'remove', left: { n: i + 1, text: o[i] } }); i++; }
    while (j < k) { rows.push({ type: 'add', right: { n: j + 1, text: n[j] } }); j++; }
    return rows;
}

/** Cheap fallback: leading-common, trailing-common, middle replaced wholesale. */
function blockDiff(o: string[], n: string[]): DiffRow[] {
    let start = 0;
    while (start < o.length && start < n.length && o[start] === n[start]) start++;
    let endO = o.length - 1, endN = n.length - 1;
    while (endO >= start && endN >= start && o[endO] === n[endN]) { endO--; endN--; }
    const rows: DiffRow[] = [];
    for (let i = 0; i < start; i++) rows.push({ type: 'same', left: { n: i + 1, text: o[i] }, right: { n: i + 1, text: n[i] } });
    for (let i = start; i <= endO; i++) rows.push({ type: 'remove', left: { n: i + 1, text: o[i] } });
    for (let j = start; j <= endN; j++) rows.push({ type: 'add', right: { n: j + 1, text: n[j] } });
    for (let i = endO + 1, j = endN + 1; i < o.length; i++, j++) rows.push({ type: 'same', left: { n: i + 1, text: o[i] }, right: { n: j + 1, text: n[j] } });
    return rows;
}

/** Collapse long runs of unchanged rows into a single 'gap' marker. */
function collapse(rows: DiffRow[], ctx: number): DiffRow[] {
    const changed = rows.map(r => r.type !== 'same');
    const keep = new Array(rows.length).fill(false);
    for (let i = 0; i < rows.length; i++) {
        if (changed[i]) {
            for (let d = -ctx; d <= ctx; d++) {
                const idx = i + d; if (idx >= 0 && idx < rows.length) keep[idx] = true;
            }
        }
    }
    const out: DiffRow[] = [];
    let hidden = 0;
    for (let i = 0; i < rows.length; i++) {
        if (keep[i]) {
            if (hidden > 0) { out.push({ type: 'gap', left: { n: 0, text: hidden + ' unchanged line' + (hidden > 1 ? 's' : '') } }); hidden = 0; }
            out.push(rows[i]);
        } else { hidden++; }
    }
    if (hidden > 0) out.push({ type: 'gap', left: { n: 0, text: hidden + ' unchanged line' + (hidden > 1 ? 's' : '') } });
    return out;
}
