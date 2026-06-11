import { describe, it, expect } from 'vitest';
import { classifyCommand } from '../src/core/commandClass';

describe('classifyCommand', () => {
  it('groups all read-only inspection commands into one `read` category', () => {
    const cmds = [
      'findstr /n /c:"historical" app.js',
      'type app.js | findstr /i "historical"',
      'type app.js',
      'powershell -Command "Get-Content app.js | Select-String -Pattern \'historical\'"',
      'dir',
      'ls -la src',
      'grep -r foo .',
      'git status',
      'git log --oneline',
    ];
    for (const c of cmds) expect(classifyCommand(c).category, c).toBe('read');
  });

  it('does NOT classify mutating / network / VCS-write commands as read', () => {
    const cat = (c: string) => classifyCommand(c).category;
    expect(cat('git push origin main')).not.toBe('read');
    expect(cat('npm install left-pad')).not.toBe('read');
    expect(cat('curl -X POST https://api.example.com')).not.toBe('read');
    expect(cat('rm -rf build')).not.toBe('read');
    expect(cat('powershell -Command "Remove-Item app.js"')).not.toBe('read');
  });

  it('keys non-read commands by their primary executable so unlike commands differ', () => {
    expect(classifyCommand('git push').category).toBe('exec:git');
    expect(classifyCommand('npm run build').category).toBe('exec:npm');
    // allowing one program never silently allows a different one
    expect(classifyCommand('git push').category).not.toBe(classifyCommand('npm test').category);
  });

  it('unwraps powershell/cmd wrappers to inspect the real command', () => {
    expect(classifyCommand('powershell -Command "git push"').category).toBe('exec:git');
    expect(classifyCommand('cmd /c type app.js').category).toBe('read');
  });

  it('never throws and does not collapse an empty command into the broad `read` grant', () => {
    expect(classifyCommand('').category).not.toBe('read');
    expect(() => classifyCommand('')).not.toThrow();
  });
});
