/**
 * Pages of a Stream Deck layout as the editor shows them: main pages (the
 * ones "next/previous page" walk through) and folders (opened by a key,
 * key 1 is always Back). A folder is a page with a parentPage.
 */
import type { StreamDeckButtonConfig, StreamDeckSettings } from "../types";

export type PageEntry = {
  page: number;
  /** 0 for a main page, 1 for a folder of it, and so on. */
  depth: number;
  isFolder: boolean;
  label: string;
};

/** Main pages in order, each followed by its folders (and theirs). */
export function pageTree(settings: StreamDeckSettings): PageEntry[] {
  const pages = [...settings.pages].sort((a, b) => a.page - b.page);
  const known = new Set(pages.map((p) => p.page));
  const childrenOf = new Map<number | null, number[]>();
  for (const p of pages) {
    // A folder whose parent is gone counts as a main page.
    const parent =
      p.parentPage !== undefined && known.has(p.parentPage) ? p.parentPage : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), p.page]);
  }
  const byNumber = new Map(pages.map((p) => [p.page, p]));
  const out: PageEntry[] = [];
  let mainCount = 0;
  let folderCount = 0;
  const visit = (pageNo: number, depth: number, seen: Set<number>) => {
    if (seen.has(pageNo)) return;
    seen.add(pageNo);
    const page = byNumber.get(pageNo);
    const isFolder = depth > 0;
    const fallback = isFolder ? `Folder ${++folderCount}` : `Page ${++mainCount}`;
    out.push({
      page: pageNo,
      depth,
      isFolder,
      label: page?.title?.trim() || fallback,
    });
    for (const child of childrenOf.get(pageNo) ?? []) visit(child, depth + 1, seen);
  };
  const seen = new Set<number>();
  for (const root of childrenOf.get(null) ?? []) visit(root, 0, seen);
  return out;
}

export function nextPageNumber(settings: StreamDeckSettings): number {
  const existing = new Set(settings.pages.map((p) => p.page));
  let n = 0;
  while (existing.has(n)) n += 1;
  return n;
}

function emptyButtons(count: number): StreamDeckButtonConfig[] {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

/**
 * Adds a folder below `parentPage` and points the key `keyIndex` of the
 * current page at it, in one step.
 */
export function addFolder(
  settings: StreamDeckSettings,
  parentPage: number,
  keyIndex: number,
): { settings: StreamDeckSettings; folder: number } {
  const folder = nextPageNumber(settings);
  const buttons = emptyButtons(settings.gridColumns * settings.gridRows);
  buttons[0] = { index: 0, label: "Back" };
  const pages = settings.pages.map((page) =>
    page.page !== parentPage
      ? page
      : {
          ...page,
          buttons: page.buttons.map((button) =>
            button.index === keyIndex
              ? { ...button, action: { type: "page_jump" as const, targetPage: folder } }
              : button,
          ),
        },
  );
  pages.push({
    page: folder,
    title: "",
    pageType: "manual",
    parentPage,
    buttons,
  });
  return { settings: { ...settings, pages }, folder };
}

/** Key 1 of a folder is Back (the server puts it there). */
export function isFixedBackKey(
  settings: StreamDeckSettings,
  pageNo: number,
  keyIndex: number,
): boolean {
  if (keyIndex !== 0) return false;
  const page = settings.pages.find((p) => p.page === pageNo);
  return (
    page?.parentPage !== undefined &&
    settings.pages.some((p) => p.page === page.parentPage)
  );
}
