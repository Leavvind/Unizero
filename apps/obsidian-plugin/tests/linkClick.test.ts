import { describe, expect, it } from "vitest";
import { editorEventOpensLink } from "../src/linkClick";

const content = { name: "content" };
const line = { name: "line" };
const element = (...classes: string[]) => ({
  parentNode: line,
  closest: (selector: string) => selector.split(", ").some((s) => classes.includes(s.slice(1))) ? {} : null,
}) as unknown as Element;
const click = (extra: Partial<MouseEvent> = {}) => ({ type: "click", button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra }) as MouseEvent;

describe("editor events Obsidian would send to the operating system", () => {
  it.each([
    ["label", ["is-live-preview", "cm-underline", "cm-link"]],
    ["revealed URL", ["is-live-preview", "cm-underline", "cm-url"]],
    ["external link icon", ["is-live-preview", "external-link"]],
  ])("takes a plain Live Preview click on the %s", (_name, classes) => {
    expect(editorEventOpensLink(click(), element(...classes), content)).toBe(true);
  });
  it("leaves a plain click for the caret in Source mode", () => {
    expect(editorEventOpensLink(click(), element("cm-underline", "cm-link"), content)).toBe(false);
    expect(editorEventOpensLink(click(), element(), content)).toBe(false);
  });
  it("takes a modifier click anywhere on the link", () => {
    expect(editorEventOpensLink(click({ ctrlKey: true }), element(), content)).toBe(true);
    expect(editorEventOpensLink(click({ metaKey: true }), element("is-live-preview"), content)).toBe(true);
  });
  it("takes a middle press but not other buttons", () => {
    const press = (button: number) => click({ type: "mousedown", button });
    expect(editorEventOpensLink(press(1), element(), content)).toBe(true);
    expect(editorEventOpensLink(press(0), element("is-live-preview", "cm-underline", "cm-link"), content)).toBe(false);
    expect(editorEventOpensLink(click({ button: 2 }), element("is-live-preview", "cm-underline", "cm-link"), content)).toBe(false);
  });
  it("leaves shift and alt clicks, which extend a selection", () => {
    const link = element("is-live-preview", "cm-underline", "cm-link");
    expect(editorEventOpensLink(click({ shiftKey: true }), link, content)).toBe(false);
    expect(editorEventOpensLink(click({ altKey: true }), link, content)).toBe(false);
  });
  it("ignores clicks on the editor or a line itself, even with a modifier", () => {
    const self = { parentNode: null, closest: () => null } as unknown as Element;
    expect(editorEventOpensLink(click({ ctrlKey: true }), self, self)).toBe(false);
    const onLine = { parentNode: content, closest: () => null } as unknown as Element;
    expect(editorEventOpensLink(click({ ctrlKey: true }), onLine, content)).toBe(false);
  });
});
