import { describe, expect, it, vi } from 'vitest';
import { foldCase, grepBinary, killTree, normalizeModelPath, NO_GIT_MESSAGE, shellCommand, spawnOptions } from '../../src/adapters/tools/platform.js';

const win = { platform: 'win32' as const };
const PF = 'C:\\Program Files';
const files = (...ps: string[]) => (p: string) => ps.includes(p);

describe('platform: shell y grep', () => {
  it('Unix: /bin/sh y grep', () => {
    expect(shellCommand('ls | wc', { platform: 'linux' })).toEqual(['/bin/sh', ['-c', 'ls | wc']]);
    expect(grepBinary({ platform: 'darwin' })).toBe('grep');
  });

  it('Windows: bash.exe de %ProgramFiles%\\Git', () => {
    const bash = `${PF}\\Git\\bin\\bash.exe`;
    const d = { ...win, env: { ProgramFiles: PF }, exists: files(bash), whereGit: () => '' };
    expect(shellCommand('echo hi', d)).toEqual([bash, ['-c', 'echo hi']]);
  });

  it('Windows: prueba ProgramFiles(x86) y LOCALAPPDATA', () => {
    const x86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
    expect(shellCommand('x', { ...win, env: { ProgramFiles: PF, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: files(x86), whereGit: () => '' })[0]).toBe(x86);
    const lad = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(shellCommand('x', { ...win, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: files(lad), whereGit: () => '' })[0]).toBe(lad);
  });

  it('Windows: vía `where git` → ../bin/bash.exe y usr\\bin\\grep.exe', () => {
    const d = {
      ...win,
      env: {},
      whereGit: () => 'D:\\Tools\\Git\\cmd\\git.exe\r\n',
      exists: files('D:\\Tools\\Git\\bin\\bash.exe', 'D:\\Tools\\Git\\usr\\bin\\grep.exe'),
    };
    expect(shellCommand('x', d)[0]).toBe('D:\\Tools\\Git\\bin\\bash.exe');
    expect(grepBinary(d)).toBe('D:\\Tools\\Git\\usr\\bin\\grep.exe');
  });

  it('Windows sin Git: mensaje claro', () => {
    const d = { ...win, env: {}, exists: () => false, whereGit: () => '' };
    expect(() => shellCommand('x', d)).toThrow(NO_GIT_MESSAGE);
    expect(() => grepBinary(d)).toThrow('Instala Git for Windows');
  });
});

describe('platform: spawn y killTree', () => {
  it('spawnOptions', () => {
    expect(spawnOptions({ platform: 'linux' })).toEqual({ detached: true });
    expect(spawnOptions(win)).toEqual({ windowsHide: true });
  });

  it('Windows: taskkill /T /F con execFile', () => {
    const ef = vi.fn();
    const kill = vi.fn();
    killTree({ pid: 42, kill } as never, { ...win, execFile: ef as never });
    expect(ef).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/T', '/F'], { windowsHide: true }, expect.any(Function));
    expect(kill).not.toHaveBeenCalled();
  });

  it('Unix: mata el grupo (-pid)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killTree({ pid: 42, kill: vi.fn() } as never, { platform: 'linux' });
    expect(spy).toHaveBeenCalledWith(-42, 'SIGKILL');
    spy.mockRestore();
  });

  it('sin pid no hace nada', () => {
    const ef = vi.fn();
    killTree({ pid: undefined, kill: vi.fn() } as never, { ...win, execFile: ef as never });
    expect(ef).not.toHaveBeenCalled();
  });
});

describe('platform: rutas', () => {
  it('Windows: separadores y rutas absolutas ≡ relativas, sin distinguir mayúsculas', () => {
    expect(normalizeModelPath('src\\a.ts', 'C:\\repo', win)).toBe('src/a.ts');
    expect(normalizeModelPath('C:\\repo\\src\\a.ts', 'C:\\repo', win)).toBe('src/a.ts');
    expect(normalizeModelPath('c:\\REPO\\src\\a.ts', 'C:\\repo', win)).toBe('src/a.ts');
    expect(normalizeModelPath('C:\\repo', 'C:\\repo', win)).toBe('.');
    expect(normalizeModelPath('D:\\otro\\x', 'C:\\repo', win)).toBe('D:/otro/x');
    expect(foldCase('Src/A.ts', win)).toBe('src/a.ts');
  });

  it('Unix: intacta', () => {
    expect(normalizeModelPath('src\\a.ts', '/repo', { platform: 'linux' })).toBe('src\\a.ts');
    expect(foldCase('Src/A.ts', { platform: 'linux' })).toBe('Src/A.ts');
  });
});
