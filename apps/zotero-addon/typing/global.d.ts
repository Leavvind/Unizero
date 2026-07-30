declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ZoteroPane: _ZoteroTypes.ZoteroPane;
  Zotero_Tabs: typeof Zotero_Tabs;
  window: Window;
  document: Document;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare class Localization { }

declare type ItemBaseInfo = {
  identifiers: {
    DOI?: string;
    arXiv?: string;
    paperID?: string;
    openAlex?: string;
  };
  title: string;
  authors: string[];
  type?: "journalArticle" | "preprint" | string;
  text?: string;
  year?: string;
  url?: string;
  _item?: _ZoteroItem;
  _itemID?: number;
  number?: number;
  [key: string]: any;
}

declare type ItemInfo = ItemBaseInfo & {
  publishDate?: string | number;
  abstract?: string | undefined;
  primaryVenue?: string
  source?: string;
  tags?: (string[] | { text: string, color: string, tip?: string })[];
  references?: ItemBaseInfo[];
}

interface Rect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
}
