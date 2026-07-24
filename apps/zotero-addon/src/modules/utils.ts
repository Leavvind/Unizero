import { PanelStatus } from "./status";
import API from "./api"


class Utils {
  API: API;
  private lock?: _ZoteroTypes.PromiseObject;
  private cache: { [key: string]: any } = {};
  public regex = {
    DOI: /10\.\d{4,9}\/[-\._;\(\)\/:A-z0-9><]+[^\.\]]/,
    arXiv: /arXiv[\.:](\d+\.\d+)/,
    URL: /https?:\/\/[^\s\.]+/
  }
  constructor() {
    this.API = new API(this);
  }

  public getIdentifiers(text: string): ItemBaseInfo["identifiers"] {
    const targets = [
      {
        key: "DOI",
        ignoreSpace: true,
        regex: this.regex.DOI
      },
      {
        key: "arXiv",
        ignoreSpace: true,
        regex: this.regex.arXiv
      }
    ]
    let identifiers: any = {}
    for (let target of targets) {
      let res = (
        target.ignoreSpace ? text.replace(/\s+/g, "") : text
      ).match(target.regex)
      if (res) {
        identifiers[target.key] = res.slice(-1)[0]
      }
    }
    return identifiers
  }

  private extractURL(text: string) {
    let res = text.match(this.regex.URL)
    if (res) {
      return res.slice(-1)[0]
    }
  }

  public parseRefText(text: string): { year?: string, authors?: string[], title: string, publicationVenue?: String } {
    try {
      text = text.replace(/^\[\d+?\]/, "")
      text = text.replace(/\s+/g, " ")
      // Match the title.
      // Anything in quotation marks is certainly the title.
      let title: string, titleMatch: string
      if (/\u201c(.+)\u201d/.test(text)) {
        [titleMatch, title] = text.match(/\u201c(.+)\u201d/)!
        if (title.endsWith(",")) {
          title = title.slice(0, -1)
        }
      } else {
        title = titleMatch = ((text.indexOf(". ") != -1 && text.match(/\.\s/g)!.length >= 2) && text.split(". ") || text.split("."))
          // Take the two longest: one is most likely the author list, the other
          // most likely the title.
          .sort((a, b) => b.length - a.length)
          // Count initials and punctuation in each; the higher count is probably
          // the authors.
          .map((s: string) => {
            let count = 0;
            [/[A-Z]\./g, /[,\.\-\(\)\:]/g, /\d/g].forEach(regex => {
              let res = s.match(regex)
              count += (res ? res.length : 0)
            })
            return [count / s.length, s]
          })
          // Filter out the journal description.
          .filter((s: any) => s[1].match(/\s+/g)?.length >= 3)
          .sort((a: any, b: any) => a[0] - b[0])![0][1] as string
        if (/\[[A-Z]\]$/.test(title)) {
          title = title.replace(/\[[A-Z]\]$/, "")
        }
      }
      title = title.trim()
      let splitByTitle = text.split(titleMatch)
      let authorInfo = splitByTitle[0].trim()

      // ztoolkit.log(splitByTitle[1])

      let publicationVenue = splitByTitle[1].match(/[^.\s].+[^\.]/)![0].split(/[,\d]/)[0].trim()
      if (authorInfo.indexOf("et al.") != -1) {
        authorInfo = authorInfo.split("et al.")[0] + "et al."
      }
      const currentYear = new Date().getFullYear();
      let res = text.match(/[^\d]\d{4}[^\d-]/g)?.map(s => s.match(/\d+/)![0])
      let year = res?.find(s => {
        return Number(s) <= Number(currentYear) + 1
      })!
      authorInfo = authorInfo.replace(`${year}.`, "").replace(year, "").trim()
      return { year, title, authors: [authorInfo], publicationVenue }
    } catch {
      return {
        title: text
      }
    }

  }

  public _parseRefText(text: string): { year: string, authors: string[], title: string } {
    // Match the year.
    let year
    let _years = text.match(/[^\d]?(\d{4})[^\d]?/g) as string[]
    if (_years) {
      let years = _years
        .map(year => Number(year.match(/\d{4}/)![0]))
        .filter(year => year > 1900 && year < (new Date()).getFullYear())
      if (years.length > 0) { year = String(years[0]) }
    }
    year = year as string
    if (this.isChinese(text)) {
      // Extract author and title. Sample inputs this branch handles:
      // [1] 张 宁, 张 雨青, 吴 坎坎. 信任的心理和神经生理机制. 2011, 1137-1143.
      // [1] 中央环保督察视角下的城市群高质量发展研究——以成渝城市群为例[J].李毅.  环境生态学.2022(04) 
      let parts = text
        .replace(/\[.+?\]/g, "")
        .replace(/\s+/g, " ")
        .split(/[\.,\uff0c\uff0e\uff3b\[\]]/) // \uff0c: ，\uff0e: ．
        .map(e => e.trim())
        .filter(e => e)
      let authors = []
      let titles = []
      for (let part of parts) {
        if (part.length <= 3 && part.length >= 2) {
          authors.push(part);
        } else {
          titles.push(part);
        }
      }
      let title = titles.sort((a, b) => b.length - a.length)[0]
      // ztoolkit.log(text, "\n->\n", title, authors)
      return { title, authors, year }
    } else {
      let authors: string[] = []
      text = text.replace(/[\u4e00-\u9fa5]/g, "")
      const authorRegexs = [/[A-Za-z,\.\s]+?\.?[\.,;]/g, /[A-Z][a-z]+ et al.,/]
      authorRegexs.forEach(regex => {
        text.match(regex)?.forEach(author => {
          authors.push(author.slice(0, -1))
        })
      })
      let title = text
        .split(/[,\.]\s/g)
        .filter((e: string) => !e.includes("http"))
        .sort((a, b) => b.length - a.length)[0]
      return { title, authors, year }
    }
  }

  public identifiers2URL(identifiers: ItemBaseInfo["identifiers"]) {
    let url
    if (identifiers.DOI) {
      url = `https://doi.org/${identifiers.DOI}`
    }
    if (identifiers.arXiv) {
      url = `https://arxiv.org/abs/${identifiers.arXiv}`
    }
    return url
  }

  public refText2Info(text: string): ItemBaseInfo {
    let identifiers = this.getIdentifiers(text)
    return {
      identifiers: identifiers,
      url: this.extractURL(text) || this.identifiers2URL(identifiers),
      authors: [],
      ...this.parseRefText(text),
      type: (identifiers.arXiv ? "preprint" : "journalArticle")
    }
  }

  /**
   * Create an item from an identifier.
   *
   * `libraryID` must be supplied by the caller — the library holding the paper
   * currently being read. This used to call `ZoteroPane.getSelectedLibraryID()`,
   * i.e. "whatever library is selected in the left pane", which inside the reader
   * can easily be a different library, so references landed somewhere unrelated to
   * the source.
   *
   * Collections are filtered by library for the same reason: a collection ID from
   * another library makes the save fail.
   */
  async createItemByZotero(
    identifiers: ItemBaseInfo["identifiers"],
    collections: number[],
    libraryID: number,
  ) {
    var translate = new Zotero.Translate.Search();
    translate.setIdentifier(identifiers);
    let translators = await translate.getTranslators();
    translate.setTranslator(translators);
    const validCollections = (collections || []).filter((id) => {
      const collection = Zotero.Collections.get(id) as Zotero.Collection | false;
      return collection && collection.libraryID === libraryID;
    });
    return (await translate.translate({
      libraryID,
      collections: validCollections,
      saveAttachments: true
    }))[0]
  }

  public searchRelatedItem(item: Zotero.Item, refItem: Zotero.Item): Zotero.Item | undefined {
    if (!item) { return }
    // A related item's key is relative to its own library, so the lookup must use
    // the item's own libraryID. Hardcoding 1 (My Library) means items in a group
    // library never find their existing relations.
    let relatedItems = item.relatedItems
      .map(key => Zotero.Items.getByLibraryAndKey(item.libraryID, key) as Zotero.Item)
      .filter(Boolean)
    if (refItem) {
      let relatedItem = relatedItems.find((item: Zotero.Item) => refItem.id == item.id)
      return relatedItem
    }
  }

  public async searchItem(info: ItemBaseInfo, libraryID?: number) {
    if (!info) { return }
    let s = new Zotero.Search(libraryID ? { libraryID } : undefined);
    // @ts-ignore
    s.addCondition("joinMode", "any");
    if (info.identifiers.DOI) {
      s.addCondition("DOI", "is", info.identifiers.DOI);
      s.addCondition("DOI", "is", info.identifiers.DOI.toLowerCase());
      s.addCondition("DOI", "is", info.identifiers.DOI.toUpperCase());
    } else {
      if (info.title && info.title?.length > 8) {
        s.addCondition("title", "contains", info.title!);
      }
      s.addCondition("url", "contains", info.identifiers.arXiv!);
    }
    var ids = await s.search();
    let items = (await Zotero.Items.getAsync(ids)).filter(i => {
      return (
        !i.itemType.startsWith("attachment") &&
        i.isRegularItem && i.isRegularItem()
      )
    });
    if (items.length) {
      return items[0]
    }
  }

  /**
   * Search the local library for an item matching this reference.
   * @param info 
   * @returns 
   */
  public async searchLibraryItem(
    info: ItemBaseInfo,
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<Zotero.Item | undefined> {
    await Zotero.Promise.delay(0)
    const key = `${libraryID}:` + JSON.stringify(info.identifiers) + info.text + "library-item"
    if (key in this.cache) {
      info._item = this.cache[key]
      return this.cache[key]
    } else {
      // Brute-force search; this can be slow.
      let items: Zotero.Item[] = await Zotero.Items.getAll(libraryID);
      let getPureText = (s: string) => (this.cache["getPureText" + s] ??= s.toLowerCase().match(/[0-9a-z\u4e00-\u9fa5]+/g)?.join("")!)
      let item = await this.searchItem(info, libraryID) || items.filter(i => (
        i.isRegularItem() &&
        i.getField("title") &&
        ["journalArtical", "preprint", "book"].indexOf(i.itemType) != -1
      )).find((item: Zotero.Item) => {
        try {
          let title = item.getField("title") as string
          if (!this.isChinese(title) && title.split(" ").length < 4) { return false }
          title = getPureText(title)
          const searchTitle = getPureText(info.title || info.text as string)
          if (searchTitle.length > 10 && title && searchTitle && (title?.indexOf(searchTitle) != -1 || searchTitle?.indexOf(title) != -1)) {
            return item;
          }
        } catch (e) {}
      })
      if (item) {
        info._item = item 
        this.cache[key] = item
        // Update info from what the local item tells us.
        info.title = item.getField("title") as string
        let DOI = item.getField("DOI") as string
        if (DOI) {
          info.identifiers = {DOI}
        }
      }
      return item
    }
  }

  public selectItemInLibrary(item: Zotero.Item) {
    Zotero_Tabs.select('zotero-pane');
    ZoteroPane.selectItem(item.id);
  }

  public getItemType(item: Zotero.Item) {
    if (!item) { return }
    return Zotero.ItemTypes.getName(
      Number(item.getField("itemTypeID" as any))
    )
  }

  public isChinese(text: string) {
    text = text.replace(/\s+/g, "")
    return (text.match(/[\u4E00-\u9FA5]/g)?.length || 0) / text.length > .5
  }

  public isDOI(text: string) {
    if (!text) { return false }
    let res = text.match(this.regex.DOI)
    if (res) {
      return res[0] == text && !/(cnki|issn)/i.test(text)
    } else {
      return false
    }
  }

  public matchArXiv(text: string) {
    let res = text.match(this.regex.arXiv)
    if (res != null && res.length >= 2) {
      return res[1]
    } else {
      return false
    }
  }

  public Html2Text(html: string): string | null {
    if (!html) { return "" }
    let text
    try {
      let span: HTMLSpanElement | null = document.createElement("span")
      span.innerHTML = html
      text = span.innerText || span.textContent
      span = null
    } catch (e) {
      text = html
    }
    if (text) {
      text = text
        .replace(/<([\w:]+?)>([\s\S]+?)<\/\1>/g, (match, p1, p2) => p2)
        .replace(/\n+/g, "")
    }
    // ztoolkit.log(text)
    return text
  }

  public getReader() {
    return Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)
  }

  public copyText = (text: string, show: boolean = true) => {
    (new ztoolkit.Clipboard()).addText(text, "text/unicode").copy();
    if (show) {
      (new PanelStatus("Copy"))
        .createLine({ text: text, type: "success" })
        .show()
    }
  }

  public getItem(): Zotero.Item | undefined {
    let reader = this.getReader()
    if (reader) {
      return reader._item.parentItem 
    }
  }

  public abs(v: number) {
    return v > 0 ? v : -v
  }
}

export default Utils
