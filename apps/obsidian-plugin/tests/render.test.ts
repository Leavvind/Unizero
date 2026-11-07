import { describe, expect, it, vi } from "vitest";
import { ChangeSet, EditorState } from "@codemirror/state";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import { scanDocumentLinks } from "../src/documentLinks";
import { editMayChangeLinks, linkLivePreview, linkLabelRanges, mapStyledLinks } from "../src/render";

const uri = "unizero://paper/1/HLP48L8X";

/** An EditorView stand-in whose whole document is in the viewport. */
function mockView(text: string) {
  return {
    state: EditorState.create({ doc: text }), dispatch: vi.fn(),
    get visibleRanges() { return [{ from: 0, to: this.state.doc.length }]; },
  };
}
type Instance = { decorations: DecorationSet; update(update: ViewUpdate): void; destroy(): void; linkAt(position: number): unknown };
/** Creates the plugin and runs its deferred first parse. */
function createPlugin(host: Parameters<typeof linkLivePreview>[0], view: ReturnType<typeof mockView>): Instance {
  const extension = linkLivePreview(host) as unknown as [{ create(view: EditorView): Instance }, unknown];
  const plugin = extension[0].create(view as unknown as EditorView);
  vi.advanceTimersByTime(0);
  const refresh = view.dispatch.mock.calls[0][0];
  plugin.update({ docChanged: false, selectionSet: false, transactions: [{ effects: [refresh.effects] }] } as unknown as ViewUpdate);
  view.dispatch.mockClear();
  return plugin;
}

describe("UniZero link label styling", () => {
  it("intercepts unfinished block links in the editor as whole-file targets", () => {
    vi.useFakeTimers();
    const text = "\n[北岛 & 林道群, 2022](unizero://paper/1/E23A232D.md^)";
    const view = mockView(text);
    const plugin = createPlugin({ openLink: vi.fn(), linkMenu: vi.fn() }, view);
    try {
      expect(plugin.linkAt(text.indexOf("北岛"))).toMatchObject({
        target: { kind: "paper", libraryID: 1, itemKey: "E23A232D", action: "markdown" },
      });
      expect(plugin.decorations.size).toBe(1);
    } finally { plugin.destroy(); vi.useRealTimers(); }
  });

  it("marks only labels, preserving formatting, destinations and reference links", () => {
    const text = `See [**Author** & Robinson, 2019](${uri}.md#Methods) and [Other][paper].\n\n[paper]: ${uri}`;
    const ranges = linkLabelRanges(scanDocumentLinks(text), []);
    expect(ranges.map(({ from, to }) => text.slice(from, to))).toEqual(["**Author** & Robinson, 2019", "Other"]);
  });

  it("marks Vault links as notes; excludes ordinary links, code, comments, images and empty labels", () => {
    const text = `[web](https://example.com) [note](unizero://note/vault/123) \`[code](${uri})\`\n`
      + `%% [comment](${uri}) %%\n![image](${uri}) [](${uri})\n\n\`\`\`md\n[fenced](${uri})\n\`\`\``;
    const ranges = linkLabelRanges(scanDocumentLinks(text), []);
    expect(ranges.map(({ from, to, kind }) => [text.slice(from, to), kind])).toEqual([["note", "note"]]);
  });

  it("leaves the whole link native while a caret or selection intersects it", () => {
    const text = `See [Author](${uri}) then [Other](${uri}.pdf?page=3)`;
    const links = scanDocumentLinks(text);
    expect(linkLabelRanges(links, [{ from: links[0].to - 3, to: links[0].to - 3 }]))
      .toEqual([{ from: links[1].labelFrom, to: links[1].labelTo, kind: "paper" }]);
    expect(linkLabelRanges(links, [{ from: 0, to: text.length }])).toEqual([]);
  });

  it("keeps label styles in place while typing elsewhere, before the reparse", () => {
    vi.useFakeTimers();
    const text = `Intro
[Author](${uri}) tail`;
    const view = mockView(text);
    const plugin = createPlugin({ openLink: vi.fn(), linkMenu: vi.fn() }, view);
    try {
      const transaction = view.state.update({ changes: { from: 0, insert: "More " } });
      view.state = transaction.state;
      plugin.update({ docChanged: true, selectionSet: false, changes: transaction.changes, transactions: [transaction] } as unknown as ViewUpdate);
      const marks: string[] = [];
      plugin.decorations.between(0, view.state.doc.length, (from, to) => { marks.push(view.state.doc.sliceString(from, to)); });
      expect(marks).toEqual(["Author"]);
    } finally {
      plugin.destroy();
      vi.useRealTimers();
    }
  });

  it("updates after a destination edit and cancels pending work on destroy", () => {
    vi.useFakeTimers();
    const host = { openLink: vi.fn(), linkMenu: vi.fn() };
    const text = `\n[Author](${uri})`;
    const view = mockView(text);
    const plugin = createPlugin(host, view);
    try {
      expect(plugin.decorations.size).toBe(1);
      const transaction = view.state.update({ changes: { from: text.indexOf(uri), to: text.length - 1, insert: "https://example.com" } });
      view.state = transaction.state;
      plugin.update({ docChanged: true, selectionSet: false, changes: transaction.changes, transactions: [transaction] } as unknown as ViewUpdate);
      expect(plugin.decorations.size).toBe(0);
      vi.advanceTimersByTime(180);
      const refresh = view.dispatch.mock.calls[0][0];
      plugin.update({ docChanged: false, selectionSet: false, transactions: [{ effects: [refresh.effects] }] } as unknown as ViewUpdate);
      expect(plugin.decorations.size).toBe(0);
      expect(host.openLink).not.toHaveBeenCalled();
      plugin.update({ docChanged: true, selectionSet: false, changes: ChangeSet.empty(view.state.doc.length), transactions: [] } as unknown as ViewUpdate);
      plugin.destroy();
      vi.advanceTimersByTime(180);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      plugin.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps a link styled while typing right before or after it", () => {
    const text = `x [Author](${uri}) y`;
    const links = scanDocumentLinks(text), link = links[0];
    let state = EditorState.create({ doc: text });
    for (const at of [link.to, link.from]) {
      const transaction = state.update({ changes: { from: at, insert: "," } });
      const mapped = mapStyledLinks(links, transaction.changes);
      expect(mapped).toHaveLength(1);
      expect(transaction.state.doc.sliceString(mapped[0].labelFrom!, mapped[0].labelTo!)).toBe("Author");
      state = EditorState.create({ doc: text });
    }
    const inside = state.update({ changes: { from: link.labelTo! + 3, insert: "z" } });
    expect(mapStyledLinks(links, inside.changes)).toEqual([]);
  });

  it("resolves clicks from the mapped links, parsing only while a reparse is pending", () => {
    vi.useFakeTimers();
    const text = `Intro\n[Author](${uri})`;
    const view = mockView(text);
    const plugin = createPlugin({ openLink: vi.fn(), linkMenu: vi.fn() }, view);
    try {
      const elsewhere = view.state.update({ changes: { from: 0, insert: "More " } });
      view.state = elsewhere.state;
      plugin.update({ docChanged: true, selectionSet: false, changes: elsewhere.changes, transactions: [elsewhere] } as unknown as ViewUpdate);
      expect(plugin.linkAt(view.state.doc.toString().indexOf("Author"))).toMatchObject({ target: { kind: "paper" } });
      expect(view.dispatch).not.toHaveBeenCalled();
      const end = view.state.doc.length;
      const typed = view.state.update({ changes: { from: end, insert: ` [New](unizero://note/v/1)` } });
      view.state = typed.state;
      plugin.update({ docChanged: true, selectionSet: false, changes: typed.changes, transactions: [typed] } as unknown as ViewUpdate);
      expect(plugin.linkAt(end + 3)).toMatchObject({ target: { kind: "note" } });
      expect(view.dispatch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(180);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      plugin.destroy();
      vi.useRealTimers();
    }
  });

  it("marks only labels inside the viewport", () => {
    vi.useFakeTimers();
    // The caret starts at 0, so the first line holds no link.
    const text = `x\n[A](${uri})\n${"filler\n".repeat(20)}[B](${uri})`;
    const view = { ...mockView(text), visibleRanges: [{ from: 0, to: 12 }] };
    const plugin = createPlugin({ openLink: vi.fn(), linkMenu: vi.fn() }, view as ReturnType<typeof mockView>);
    try { expect(plugin.decorations.size).toBe(1); } finally { plugin.destroy(); vi.useRealTimers(); }
  });

  it("reparses only for edits on lines that hold or held a UniZero link", () => {
    const text = `Intro
[Author](${uri})
[d]: ${uri}`;
    const state = EditorState.create({ doc: text });
    const elsewhere = state.update({ changes: { from: 0, insert: "More " } });
    expect(editMayChangeLinks(state.doc, elsewhere.state.doc, elsewhere.changes)).toBe(false);
    const onLink = state.update({ changes: { from: text.indexOf("[Author]"), insert: "!" } });
    expect(editMayChangeLinks(state.doc, onLink.state.doc, onLink.changes)).toBe(true);
    const definition = text.indexOf("[d]") - 1;
    const removed = state.update({ changes: { from: definition, to: text.length } });
    expect(editMayChangeLinks(state.doc, removed.state.doc, removed.changes)).toBe(true);
  });
});
