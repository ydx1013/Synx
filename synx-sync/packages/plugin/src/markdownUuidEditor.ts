import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { findMarkdownUuidRanges } from './markdownUuid.js';

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of findMarkdownUuidRanges(view.state.doc.toString())) {
    builder.add(range.from, range.to, Decoration.replace({}));
  }
  return builder.finish();
}

export const hideMarkdownUuidExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.decorations = buildDecorations(update.view);
  }
}, {
  decorations: (value) => value.decorations,
});
