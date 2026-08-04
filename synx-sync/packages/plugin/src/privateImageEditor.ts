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

class PrivateImageWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly load: (galleryId: string, path: string) => Promise<Blob>,
  ) {
    super();
  }

  eq(other: PrivateImageWidget): boolean {
    return this.source === other.source;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'synx-private-image-preview';
    container.textContent = '正在加载私有图片…';
    const reference = parsePrivateImageUrl(this.source);
    if (!reference) return container;

    void this.load(reference.galleryId, reference.path).then((blob) => {
      if (!container.isConnected) return;
      const objectUrl = URL.createObjectURL(blob);
      const image = document.createElement('img');
      image.src = objectUrl;
      image.alt = 'Synx 私有图片';
      image.addEventListener('load', () => container.replaceChildren(image), { once: true });
      image.addEventListener('error', () => {
        URL.revokeObjectURL(objectUrl);
        container.textContent = 'Synx 私有图片加载失败';
      }, { once: true });
      container.dataset.objectUrl = objectUrl;
    }).catch(() => {
      container.textContent = 'Synx 私有图片加载失败';
    });
    return container;
  }

  destroy(dom: HTMLElement): void {
    const objectUrl = dom.dataset.objectUrl;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function buildDecorations(
  view: EditorView,
  load: (galleryId: string, path: string) => Promise<Blob>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const content = view.state.doc.toString();
  const selections = view.state.selection.ranges;
  for (const match of content.matchAll(PRIVATE_IMAGE_EMBED)) {
    const from = match.index;
    const to = from + match[0].length;
    if (selections.some((selection) => selection.from <= to && selection.to >= from)) continue;
    builder.add(from, to, Decoration.replace({
      widget: new PrivateImageWidget(match[1], load),
      block: true,
    }));
  }
  return builder.finish();
}

export function privateImageEditorExtension(
  load: (galleryId: string, path: string) => Promise<Blob>,
) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, load);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view, load);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}
