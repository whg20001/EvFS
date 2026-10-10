'use client';

import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import { codeLanguage } from '../lib/code-language';
import { LIMITS, type CodeLanguage } from '@sanxing/contracts';

export default function CodeEditor({ value, language, disabled, onChange }: { value: string; language: CodeLanguage; disabled: boolean; onChange: (value: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: latest.current.value, extensions: [
      basicSetup, syntaxHighlighting(classHighlighter),
      // Preserve the editor's literal colors for null and specialized strings.
      syntaxHighlighting(tagHighlighter([{ tag: tags.null, class: 'tok-atom' }, { tag: tags.special(tags.string), class: 'tok-string' }])), codeLanguage(language)!,
      editable.current.of(EditorView.editable.of(!disabled)), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': '代码答案', 'aria-multiline': 'true', 'spellcheck': 'false' }),
      EditorState.transactionFilter.of(transaction => transaction.newDoc.length <= LIMITS.answerChars ? transaction : []),
      EditorView.updateListener.of(update => { if (update.docChanged) { const text = update.state.doc.toString(); if (text !== latest.current.value) latest.current.onChange(text); } }),
      EditorView.theme({ '&': { backgroundColor: 'var(--surface)', color: 'var(--ink)', fontSize: '14px' }, '.cm-scroller': { fontFamily: 'var(--mono)', maxHeight: '560px', minHeight: '220px' }, '.cm-content': { padding: '12px 0', caretColor: 'var(--ink)' }, '.cm-gutters': { backgroundColor: 'var(--subtle)', color: 'var(--muted)', borderColor: 'var(--line)' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--primary-faint)' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--primary-light)' }, '.cm-cursor': { borderLeftColor: 'var(--ink)' } }),
    ] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [language]);
  useEffect(() => { const editor = view.current; if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }); }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!disabled)) }); }, [disabled]);
  return <div className="code-editor" ref={host} />;
}
