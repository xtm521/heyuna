import { describe, expect, it } from 'vitest';
import type { editor } from 'monaco-editor';
import { detachDiffModels } from '../src/SafeDiffEditor';

describe('Monaco model ownership', () => {
  it('detaches the diff widget before disposing either model', () => {
    let attached = true;
    const disposed: string[] = [];
    const instance = {
      getModel: () => ({
        original: { dispose: () => { expect(attached).toBe(false); disposed.push('original'); } },
        modified: { dispose: () => { expect(attached).toBe(false); disposed.push('modified'); } },
      }),
      setModel: (value: unknown) => { expect(value).toBeNull(); attached = false; },
    };
    detachDiffModels(instance as unknown as editor.IStandaloneDiffEditor);
    expect(disposed).toEqual(['original', 'modified']);
  });
});
