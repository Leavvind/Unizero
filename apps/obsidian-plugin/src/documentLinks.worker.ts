import { scanCanvasLinks, scanDocumentLinks } from "./documentLinks";

self.onmessage = (event: MessageEvent<{ text: string; format: "md" | "canvas" }>) => {
  try {
    const { text, format } = event.data;
    self.postMessage({ links: format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
