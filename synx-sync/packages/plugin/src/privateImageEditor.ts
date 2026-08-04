import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { parsePrivateImageUrl } from './privateImage.js';

const PRIVATE_IMAGE_EMBED = /!\[[^\]]*\]\((synx-image:\/\/[^\s)]+)\)/g;

/**
 * Live Preview Widget：把 synx-image:// 链接渲染为 <img>。
 * 直接用 HTTPS URL 作为 src（Worker 支持 ?token= query 参数鉴权），
 * 无需异步获取 Blob，Obsidian 原生加载图片。
 */
class PrivateImageWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly resolveUrl: (galleryId: string, path: string) => string,
  ) {
    super();
  }

  eq(other: PrivateImageWidget): boolean {
    return this.source === other.source;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'synx-private-image-preview';
    const reference = parsePrivateImageUrl(this.source);
    if (!reference) return container;

    const img = document.createElement('img');
    img.src = this.resolveUrl(reference.galleryId, reference.path);
    img.alt = 'Synx 私有图片';
    img.addEventListener('error', () => {
      container.textContent = 'Synx 私有图片加载失败';
    }, { once: true });
    container.replaceChildren(img);
    return container;
  }
}

function buildDecorations(
  view: EditorView,
  resolveUrl: (galleryId: string, path: string) => string,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const content = view.state.doc.toString();
  const selections = view.state.selection.ranges;
  for (const match of content.matchAll(PRIVATE_IMAGE_EMBED)) {
    const from = match.index;
    const to = from + match[0].length;
    if (selections.some((selection) => selection.from <= to && selection.to >= from)) continue;
    builder.add(from, to, Decoration.replace({
      widget: new PrivateImageWidget(match[1], resolveUrl),
      block: true,
    }));
  }
  return builder.finish();
}

export function privateImageEditorExtension(
  resolveUrl: (galleryId: string, path: string) => string,
) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, resolveUrl);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view, resolveUrl);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}
