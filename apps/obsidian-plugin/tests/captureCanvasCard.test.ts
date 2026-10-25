import { describe, expect, it, vi } from "vitest";
import {
  appendToTextCard,
  appendWithLineBreak,
  type SelectedCardContext,
} from "../src/capture/canvasCard";

describe("selected Card append", () => {
  it("adds one line break before plain text", () => {
    expect(appendWithLineBreak("existing", "incoming")).toBe("existing\nincoming");
    expect(appendWithLineBreak("existing\n", "incoming")).toBe("existing\nincoming");
    expect(appendWithLineBreak("", "incoming")).toBe("incoming");
  });

  it("writes formatted Zotero content through the runtime Card", () => {
    const setData = vi.fn();
    const requestSave = vi.fn();
    const context = {
      canvas: { requestSave },
      card: { setData },
      data: { type: "text", text: "existing" },
      document: {} as Document,
    } satisfies SelectedCardContext;

    expect(appendToTextCard(
      context,
      "“Quote” ([Author, 2026, p. 2](zotero://open-pdf/item/1?page=2))",
    )).toBe("inserted");
    expect(setData).toHaveBeenCalledWith(
      { type: "text", text: "existing\nQuote [Author, 2026](zotero://open-pdf/item/1?page=2)" },
      true,
    );
    expect(requestSave).toHaveBeenCalledOnce();
  });

  it("reports runtime Cards without a writer and leaves them alone", () => {
    const context = {
      canvas: {},
      card: {},
      data: { type: "text", text: "existing" },
      document: {} as Document,
    } satisfies SelectedCardContext;
    expect(appendToTextCard(context, "incoming")).toBe("unsupported");
  });
});
