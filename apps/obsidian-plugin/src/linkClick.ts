type LinkEvent = Pick<MouseEvent, "type" | "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;
type LinkElement = Pick<Element, "closest" | "parentNode">;

/**
 * Whether Obsidian's own editor would follow a link for this event. Obsidian sends such
 * a click to `window.open`, which hands a `unizero://` URI to the operating system, so
 * the plugin has to take exactly these events. Mirrors `onEditorClick` in Obsidian 1.15.
 */
export function editorEventOpensLink(event: LinkEvent, target: LinkElement, content: unknown): boolean {
  const middle = event.type === "mousedown" && event.button === 1;
  if (!middle && !(event.type === "click" && event.button === 0)) { return false; }
  if (target === content || target.parentNode === content) { return false; }
  if (middle || event.ctrlKey || event.metaKey) { return true; }
  if (event.shiftKey || event.altKey || !target.closest(".is-live-preview")) { return false; }
  return !!target.closest(".external-link")
    || (!!target.closest(".cm-underline") && !!target.closest(".cm-url, .cm-link"));
}
