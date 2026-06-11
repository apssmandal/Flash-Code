import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session/sessionManager';
import { makeContext } from './mocks/vscode';

describe('SessionManager', () => {
  it('tracks user/assistant turns and exposes UI turns + history', () => {
    const sm = new SessionManager(makeContext());
    const idx = sm.addUser('hello');
    expect(idx).toBe(0);
    sm.addAssistant('hi there');
    expect(sm.uiTurns).toHaveLength(2);
    expect(sm.history().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('persists and reloads a session by id', () => {
    const ctx = makeContext();
    const a = new SessionManager(ctx);
    a.addUser('remember me');
    a.addAssistant('ok');
    a.save();
    const id = a.sessionId;

    const b = new SessionManager(ctx);
    b.load(id);
    expect(b.uiTurns[0].content).toBe('remember me');
    expect(b.uiTurns).toHaveLength(2);
  });

  it('indexes saved sessions and supports deletion', () => {
    const ctx = makeContext();
    const sm = new SessionManager(ctx);
    sm.addUser('first message here');
    sm.save();
    expect(sm.listSessions().some((s) => s.id === sm.sessionId)).toBe(true);
    const id = sm.sessionId;
    sm.deleteSession(id);
    expect(sm.listSessions().some((s) => s.id === id)).toBe(false);
  });

  it('compactInto sets the summary and trims model history to the last `keep`, keeping UI turns', () => {
    const sm = new SessionManager(makeContext());
    for (let i = 0; i < 10; i++) { sm.addUser('u' + i); sm.addAssistant('a' + i); }
    expect(sm.modelMessageCount).toBe(20);

    const { dropped, freedTokens } = sm.compactInto('SUMMARY', 8);
    expect(dropped).toBe(12);
    expect(freedTokens).toBeGreaterThan(0);         // estimated tokens freed
    expect(sm.modelMessageCount).toBe(8);          // model window shrank
    expect(sm.history()).toHaveLength(8);
    expect(sm.history()[7].content).toBe('a9');     // most recent kept
    expect(sm.rollingSummary).toBe('SUMMARY');
    expect(sm.uiTurns).toHaveLength(20);            // transcript preserved for display
  });

  it('compactInto is a no-op when history already fits within `keep`', () => {
    const sm = new SessionManager(makeContext());
    sm.addUser('x'); sm.addAssistant('y');
    expect(sm.compactInto('S', 8)).toEqual({ dropped: 0, freedTokens: 0 });
    expect(sm.modelMessageCount).toBe(2);
  });

  it('newChat resets state', () => {
    const sm = new SessionManager(makeContext());
    sm.addUser('x');
    const old = sm.sessionId;
    sm.newChat();
    expect(sm.sessionId).not.toBe(old);
    expect(sm.uiTurns).toHaveLength(0);
  });
});
