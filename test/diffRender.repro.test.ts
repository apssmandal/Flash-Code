import { describe, it, expect } from 'vitest';
import { computeSideBySide } from '../src/diffUtils';

// Faithful copies of chat.html's collapse + render to prove the host's rows render.
function collapseDiffRows(rows: any[], ctx = 3) {
  const changed = rows.map((r) => r.type !== 'same');
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) if (changed[i]) for (let d = -ctx; d <= ctx; d++) { const idx = i + d; if (idx >= 0 && idx < rows.length) keep[idx] = true; }
  const out: any[] = []; let gap: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) { if (gap.length) { out.push({ type: 'gap', hiddenRows: gap }); gap = []; } out.push(rows[i]); }
    else gap.push(rows[i]);
  }
  if (gap.length) out.push({ type: 'gap', hiddenRows: gap });
  return out;
}
function renderDiffRow(r: any) {
  if (r.type === 'remove') return `<div class="drow remove"><span class="c">${r.left.text}</span></div>`;
  if (r.type === 'add') return `<div class="drow add"><span class="c">${r.right.text}</span></div>`;
  return `<div class="drow same"><span class="c">${r.left.text}</span></div>`;
}
function buildDiff(rows: any[]) {
  return collapseDiffRows(rows).map((r) => (r.type === 'gap' ? `<div class="drow gap">+${r.hiddenRows.length}</div>` : renderDiffRow(r))).join('');
}

describe('diff render pipeline (host rows → chat.html render)', () => {
  it('produces green add + red remove rows for an edit', () => {
    const oldText = 'line a\nconst x = 1;\nline c';
    const newText = 'line a\nconst x = 2;\nline c';
    const rows = computeSideBySide(oldText, newText, 100000);
    const html = buildDiff(rows);
    expect(html).toContain('drow remove');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('drow add');
    expect(html).toContain('const x = 2;');
  });

  it('renders a brand-new file as all additions', () => {
    const html = buildDiff(computeSideBySide('', 'export const y = 2;\nconsole.log(y);', 100000));
    expect(html).toContain('drow add');
    expect(html).not.toContain('drow remove');
  });
});
