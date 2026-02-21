/**
 * Read-only code viewer powered by CodeMirror 6.
 *
 * Styled to match VS Code's Monaco editor: inherits editor font,
 * line-number gutter styling, and theme colors from VS Code CSS variables.
 */

import { useRef, useEffect, useState } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting, foldGutter, bracketMatching, foldKeymap } from "@codemirror/language";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { keymap } from "@codemirror/view";

const vsCodeHighlight = HighlightStyle.define([
  { tag: tags.string, class: "tok-string" },
  { tag: tags.number, class: "tok-number" },
  { tag: tags.bool, class: "tok-boolean" },
  { tag: tags.null, class: "tok-null" },
  { tag: tags.propertyName, class: "tok-key" },
  { tag: tags.punctuation, class: "tok-punctuation" },
]);

const vsCodeTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--vscode-editor-foreground)",
    fontSize: "var(--vscode-editor-font-size, 12px)",
    fontFamily: "var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "var(--vscode-editor-lineHeight, 18px)",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground, #aeafad)",
    padding: "0",
  },

  // Gutter — match Monaco's line number style
  ".cm-gutters": {
    backgroundColor: "var(--vscode-editorGutter-background, var(--vscode-editor-background, transparent))",
    borderRight: "none",
    color: "var(--vscode-editorLineNumber-foreground, #858585)",
    fontFamily: "inherit",
    fontSize: "inherit",
    minWidth: "40px",
  },
  ".cm-gutter.cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 16px",
    minWidth: "auto",
    textAlign: "right",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--vscode-editorLineNumber-activeForeground, #c6c6c6)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.04))",
  },

  // Fold gutter — match VS Code's fold arrows
  ".cm-gutter.cm-foldGutter .cm-gutterElement": {
    padding: "0 4px",
    cursor: "pointer",
    color: "var(--vscode-editorGutter-foldingControlForeground, #c5c5c5)",
    opacity: "0",
    transition: "opacity 0.15s",
  },
  "&:hover .cm-gutter.cm-foldGutter .cm-gutterElement": {
    opacity: "1",
  },

  // Selection
  ".cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground, #264f78) !important",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground, #264f78) !important",
  },

  // Matching brackets
  ".cm-matchingBracket": {
    backgroundColor: "var(--vscode-editorBracketMatch-background, rgba(0,100,0,0.3))",
    outline: "1px solid var(--vscode-editorBracketMatch-border, #888)",
  },

  // Scrollbar
  ".cm-scroller::-webkit-scrollbar": {
    width: "8px",
    height: "8px",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    background: "var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4))",
    borderRadius: "4px",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    background: "var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7))",
  },
});

function createEditorState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      vsCodeTheme,
      syntaxHighlighting(vsCodeHighlight),
      json(),
      lineNumbers(),
      foldGutter(),
      drawSelection(),
      highlightActiveLine(),
      highlightSpecialChars(),
      bracketMatching(),
      keymap.of(foldKeymap),
      EditorView.lineWrapping,
    ],
  });
}

interface CodeViewerProps {
  data: unknown;
  language?: "json";
}

export function CodeViewer({ data }: CodeViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [copied, setCopied] = useState(false);

  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: createEditorState(text),
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== text) {
      view.setState(createEditorState(text));
    }
  }, [text]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div class="code-viewer-wrapper">
      <div class="code-viewer-toolbar">
        <button
          class="text-[10px] muted px-1.5 py-0.5 rounded hover:bg-hover transition-colors cursor-pointer"
          onClick={handleCopy}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div ref={containerRef} class="code-viewer-editor" />
    </div>
  );
}
