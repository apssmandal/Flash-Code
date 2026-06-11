import { describe, it, expect } from 'vitest';
import { computeSideBySide, hasDiff } from '../src/diffUtils';

describe('diffUtils.computeSideBySide', () => {
  it('marks identical text as all-same (collapsed)', () => {
    const rows = computeSideBySide('a\nb\nc', 'a\nb\nc');
    expect(rows.every((r) => r.type === 'same' || r.type === 'gap')).toBe(true);
    expect(rows.some((r) => r.type === 'add' || r.type === 'remove')).toBe(false);
  });

  it('detects a single changed line as remove + add', () => {
    const rows = computeSideBySide('a\nb\nc', 'a\nB\nc');
    expect(rows.some((r) => r.type === 'remove' && r.left?.text === 'b')).toBe(true);
    expect(rows.some((r) => r.type === 'add' && r.right?.text === 'B')).toBe(true);
  });

  it('treats a pure addition at the end as add rows', () => {
    const rows = computeSideBySide('a', 'a\nb');
    expect(rows.some((r) => r.type === 'add' && r.right?.text === 'b')).toBe(true);
  });

  it('treats empty old text (new file) as all additions', () => {
    const rows = computeSideBySide('', 'x\ny');
    expect(rows.filter((r) => r.type === 'add')).toHaveLength(2);
    expect(rows.some((r) => r.type === 'remove')).toBe(false);
  });

  it('collapses long unchanged runs into a gap marker', () => {
    const big = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
    const changed = big.replace('line0', 'CHANGED0');
    const rows = computeSideBySide(big, changed, 2);
    expect(rows.some((r) => r.type === 'gap')).toBe(true);
  });

  it('falls back to block diff for very large files without crashing', () => {
    const o = Array.from({ length: 800 }, (_, i) => `a${i}`).join('\n');
    const n = Array.from({ length: 800 }, (_, i) => (i === 400 ? 'CHANGED' : `a${i}`)).join('\n');
    const rows = computeSideBySide(o, n);
    expect(rows.some((r) => r.type === 'add' || r.type === 'remove')).toBe(true);
  });
});

describe('diffUtils.hasDiff', () => {
  it('returns false for equal strings and true otherwise', () => {
    expect(hasDiff('a', 'a')).toBe(false);
    expect(hasDiff('a', 'b')).toBe(true);
  });
});
