import { useLayoutEffect, useRef } from 'react';
import { DiffEditor, type DiffEditorProps } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

type Props = Pick<DiffEditorProps, 'original' | 'modified' | 'language' | 'theme' | 'options'>;

export function detachDiffModels(instance: editor.IStandaloneDiffEditor) {
  const models = instance.getModel();
  // Monaco requires detaching before model disposal. The React adapter's
  // default cleanup does the reverse, which races with pending diff work.
  instance.setModel(null);
  models?.original.dispose();
  models?.modified.dispose();
}

export default function SafeDiffEditor(props: Props) {
  const instance = useRef<editor.IStandaloneDiffEditor | null>(null);
  useLayoutEffect(() => () => {
    if (instance.current) detachDiffModels(instance.current);
    instance.current = null;
  }, []);
  return <DiffEditor {...props} keepCurrentOriginalModel keepCurrentModifiedModel
    onMount={value => { instance.current = value; }} />;
}
