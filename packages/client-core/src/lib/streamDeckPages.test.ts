import { describe, expect, it } from "vitest";
import type { StreamDeckSettings } from "../types";
import { addFolder, isFixedBackKey, pageTree } from "./streamDeckPages";

const keys = () => Array.from({ length: 15 }, (_, index) => ({ index }));
const layout = (
  pages: Array<{ page: number; title?: string; parentPage?: number }>,
): StreamDeckSettings => ({
  version: 1,
  gridColumns: 5,
  gridRows: 3,
  selectedPage: 0,
  pages: pages.map((p) => ({ ...p, pageType: "manual", buttons: keys() })),
});

describe("Stream Deck pages", () => {
  it("lists main pages with their folders right behind them", () => {
    const tree = pageTree(
      layout([
        { page: 0 },
        { page: 1, title: "Cameras" },
        { page: 2, parentPage: 0 },
        { page: 3, parentPage: 2, title: "Deep" },
        { page: 4, parentPage: 99 }, // parent gone: a main page
      ]),
    );
    expect(tree.map((e) => [e.page, e.depth, e.label])).toEqual([
      [0, 0, "Page 1"],
      [2, 1, "Folder 1"],
      [3, 2, "Deep"],
      [1, 0, "Cameras"],
      [4, 0, "Page 3"],
    ]);
    expect(tree.filter((e) => e.isFolder).map((e) => e.page)).toEqual([2, 3]);
  });

  it("adds a folder and points the key at it in one step", () => {
    const { settings, folder } = addFolder(layout([{ page: 0 }, { page: 1 }]), 0, 4);
    expect(folder).toBe(2);
    const created = settings.pages.find((p) => p.page === 2);
    expect(created?.parentPage).toBe(0);
    expect(created?.buttons).toHaveLength(15);
    expect(settings.pages[0].buttons[4].action).toEqual({
      type: "page_jump",
      targetPage: 2,
    });
    expect(isFixedBackKey(settings, 2, 0)).toBe(true);
    expect(isFixedBackKey(settings, 2, 1)).toBe(false);
    expect(isFixedBackKey(settings, 0, 0)).toBe(false);
  });
});
