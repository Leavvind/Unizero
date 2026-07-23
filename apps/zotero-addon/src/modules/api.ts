import { PanelStatus } from "./status";
import Utils from "./utils"
import { config } from "../../package.json";
import { MAILTO } from "./scholarlyHttp";
import {
  fetchSemanticScholarPaperByDOI,
  resolveSemanticScholarPaperByDOI,
} from "./semanticScholarApi";
import Requests from "./requests";

/**
 * CNKI is deliberately not used: the default PDF processing already extracts
 * Chinese references, and CNKI returns them in the wrong order.
 */
class API {
  public utils: Utils;
  public requests: Requests;
  public Info: { crossref: Function, connectedpapers: Function,readpaper: Function, semanticscholar: Function, unpaywall: Function, arXiv: Function };
  public BaseInfo: { readcube: Function };
  constructor(utils: Utils) {
    this.utils = utils
    this.requests = new Requests()
    this.Info = {
      crossref: (item: any) => {
        const types: any = {
          "journal-article": "journalArticle",
          "report": "report",
          "posted-content": "preprint",
          "book-chapter": "bookSection"
        }
        let references: ItemBaseInfo[] = item.reference?.map((item: any) => {
          let identifiers
          let url: string | undefined
          let text: string
          let textInfo: any = {}
          if (item.unstructured) {
            text = item.unstructured
            textInfo = this.utils.refText2Info(text)
          } else {
            if (
              item["article-title"] &&
              item.year &&
              item.author
            ) {
              text = `${item.author} et al., ${item.year}, ${item["article-title"]}`
            } else {
              let textArray = []
              for (let key in item) {
                textArray.push(`${key}: ${item[key]}`)
              }
              text = textArray.join("; ")
            }
          }
          if (item.DOI) {
            identifiers = { DOI: item.DOI }
            url = this.utils.identifiers2URL(identifiers)
          }
          let info: ItemBaseInfo = {
            identifiers: identifiers || textInfo!.identifiers || {},
            title: item["article-title"],
            authors: [item?.author],
            year: item.year,
            text: text,
            type: types[item.type] || "journalArticle",
            url: textInfo?.url || url
          }
          return info
        })
        const refCount = item["is-referenced-by-count"]
        let info: ItemInfo = {
          identifiers: { DOI: item.DOI },
          authors: item?.author?.map((i: any) => i.family),
          title: Array.isArray(item.title) ? item.title[0] : item.title,
          year: item.published && item.published["date-parts"][0][0],
          type: types[item.type] || "journalArticle",
          text: item.title[0],
          url: item.URL,
          abstract: item.abstract,
          publishDate: item.published && item.published["date-parts"][0].join("-"),
          source: item.source.toLowerCase(),
          primaryVenue: item["container-title"] ? item["container-title"][0] : [],
          references: references,
          tags: [
            ...(refCount && refCount > 0 ? [{
              text: refCount,
              color: "#2fb8cb",
              tip: "is-referenced-by-count"
            }] : []),
          ]
        }
        return info
      },
      connectedpapers: (item: any) => {
        let info: ItemInfo = {
          identifiers: { DOI: item.doiInfo.doi },
          authors: item?.authors?.map((i: any) => i[0].name),
          title: item.title.text,
          year: item.year.text,
          type: "journalArticle",
          text: item.title.text,
          url: item.doiInfo.doiUrl,
          abstract: item.paperAbstract.text,
          source: "connectedpapers",
          primaryVenue: item.venue.text,
          references: [],
          tags: [
            { text: item.citationStats.numCitations, tip: "citationStats.numCitations", color: "rgba(53, 153, 154, 0.5)" },
            { text: item.citationStats.numReferences, tip: "citationStats.numReferences", color: "rgba(53, 153, 154, 0.75)" }
          ]
        }
        return info
      },
      readpaper: (data: any) => {
        let info: ItemInfo = {
          identifiers: {},
          title: this.utils.Html2Text(data.title) as string,
          year: data.year,
          publishDate: data.publishDate,
          authors: data?.authorList.map((i: any) => this.utils.Html2Text(i.name)),
          abstract: this.utils.Html2Text(data.summary) as string,
          primaryVenue: this.utils.Html2Text(data.primaryVenue) as string,
          tags: [
            ...(data.venueTags || []),
            ...(
              data.citationCount && data.citationCount > 0 ?
                [
                  {
                    text: data.citationCount,
                    tip: "citationCount",
                    color: "#1f71e0"
                  }
                ] : []
            )
          ],
          source: "readpaper",
          type: "journalArticle"
        }
        return info
      },
      semanticscholar(data: any) {
        let info: ItemInfo = {
          identifiers: { DOI: data.DOI },
          title: data.title,
          authors: data.authors.map((i: any) => i.name),
          year: data.year,
          publishDate: data.publicationDate,
          abstract: data.abstract,
          source: "semanticscholar",
          type: "journalArticle",
          // The citation count is shown as a tag, matching readpaper; the tooltip
          // reads "Cited N times".
          tags: [
            ...(data.fieldsOfStudy || []),
            ...(data.citationCount > 0
              ? [{ text: String(data.citationCount), tip: "citationCount", color: "#1f71e0" }]
              : []),
          ],
          primaryVenue: data.journal?.name,
          url: data.DOI ? `http://doi.org/${data.DOI}` : undefined
        }
        return info
      },
      unpaywall(data: any) {
        const types: any = {
          "journal-article": "journalArticle",
          "report": "report",
          "posted-content": "preprint",
          "book-chapter": "bookSection"
        }
        let info: ItemInfo = {
          identifiers: { DOI: data.DOI },
          authors: data.z_authors.map((i: any) => i.family),
          title: data.title,
          year: data.year,
          type: types[data.genre],
          primaryVenue: data.journal_name,
          source: "unpaywall",
          publishDate: data.published_date,
          abstract: undefined
        }
        return info
      },
      arXiv: (data: any) => {
        let info: ItemInfo = {
          identifiers: { arXiv: data.arXiv },
          title: data.title[0].replace(/\n/g, ""),
          year: data.year,
          authors: data.author.map((e: any) => e.name[0]),
          abstract: data.summary[0].replace(/\n/g, ""),
          url: this.utils.identifiers2URL({ arXiv: data.arXiv }),
          type: "preprint",
          tags: data.category.map((e: any) => e["$"].term),
          publishDate: data.published && data.published[0],
          primaryVenue: data["arxiv:comment"] && data["arxiv:comment"][0]["_"].replace(/\n/g, "")
        }
        return info
      }
    }
    this.BaseInfo = {
      readcube: (data: any) => {
        let identifiers
        if (data.doi && this.utils.regex.arXiv.test(data.doi)) {
          data.arxiv = data.doi.match(this.utils.regex.arXiv).slice(-1)[0]
          data.doi = undefined
        }
        let type = "journalArticle"
        if (data.arxiv && !data.doi) {
          identifiers = { arXiv: data.arxiv }
          type = "preprint"
        } else {
          identifiers = { DOI: data.doi }
        }
        let url = this.utils.identifiers2URL(identifiers)
        let related: ItemBaseInfo = {
          identifiers: identifiers,
          title: data.title,
          authors: data?.authors,
          year: data.year,
          type: type,
          text: data.title,
          url: url
        }
        return related
      }
    }
  }

  // For DOI
  async getDOIBaseInfo(DOI: string): Promise<ItemBaseInfo | undefined> {
    let response = await fetchSemanticScholarPaperByDOI(DOI, ["title", "year", "authors"])
    if (response) {
      response.DOI = DOI
      return this.Info.semanticscholar(response) as ItemBaseInfo
    }
    response = await this.requests.get(`https://api.unpaywall.org/v2/${DOI}?email=${MAILTO}`)
    if (response) {
      response.DOI = DOI
      return this.Info.unpaywall(response) as ItemBaseInfo
    }
  }

  /**
   * From semanticscholar API
   * @param DOI 
   */
  async getDOIInfoBySemanticscholar(DOI: string): Promise<ItemInfo | undefined> {
    let response = await fetchSemanticScholarPaperByDOI(DOI, [
      "title", "authors", "abstract", "year", "journal", "fieldsOfStudy",
      "publicationVenue", "publicationDate", "citationCount",
    ])
    if (response) {
      response.DOI = DOI
      if (!response.abstract) {
        // The abstract may have been too long for the API; fetch the web page instead.
        let text = await this.requests.get(
          `https://www.semanticscholar.org/paper/${response.paperId}`,
          "text/html"
        )
        let parser = new DOMParser()
        let doc = parser.parseFromString(text, "text/html")
        const abstract = doc.head.querySelector("meta[name=description]")?.getAttribute("content")
        if (!abstract?.startsWith("Semantic Scholar")) {
          response.abstract = abstract || undefined
        }
      }
      return this.Info.semanticscholar(response)
    }
  }

  async getDOIInfoByCrossref(DOI: string): Promise<ItemInfo | undefined> {
    const api = `https://api.crossref.org/works/${DOI}/transform/application/vnd.citationstyles.csl+json`
    let response = await this.requests.get(api)
    if (response) {
      response.DOI = DOI
      let info: ItemInfo = this.Info.crossref(response)
      return info
    }
  }

  // async getDOIRelatedArray(DOI: string): Promise<ItemBaseInfo[] | undefined> {
  //   const api = `https://services.readcube.com/reader/related?doi=${DOI}`
  //   let response = await this.requests.get(api)
  //   if (response) {
  //     let arr: ItemBaseInfo[] = response.map((i: any) => {
  //       return this.BaseInfo.readcube(i) as ItemBaseInfo
  //     })
  //     return arr
  //   }
  // }


  async getDOIRelatedArray(DOI: string, limit: number = 20): Promise<ItemBaseInfo[] | undefined> {
    // The legacy "related recommendations" have no stable endpoint; the reference
    // pane must not quietly call a second recommendation service in the
    // background. If related papers or a graph view are redesigned, they belong in
    // a separate feature rather than tied to metadata enrichment.
    return
  }

  /**
   * Parse the first <entry> of an arXiv Atom feed.
   * Returns the same shape the previous xml2js-based path produced
   * (every value wrapped in an array), so `Info.arXiv` is unchanged.
   */
  private parseArXivEntry(xml: string): any | undefined {
    const doc = new DOMParser().parseFromString(xml, "application/xml")
    const entry = doc.getElementsByTagName("entry")[0]
    if (!entry || doc.getElementsByTagName("parsererror").length > 0) { return }
    const textOf = (tag: string) =>
      Array.from(entry.getElementsByTagName(tag)).map((e) => e.textContent ?? "")
    const comment = entry.getElementsByTagName("arxiv:comment")[0]
    return {
      title: textOf("title"),
      summary: textOf("summary"),
      published: textOf("published"),
      author: Array.from(entry.getElementsByTagName("author")).map((a) => ({
        name: Array.from(a.getElementsByTagName("name")).map((n) => n.textContent ?? ""),
      })),
      category: Array.from(entry.getElementsByTagName("category")).map((c) => ({
        $: { term: c.getAttribute("term") },
      })),
      "arxiv:comment": comment ? [{ _: comment.textContent ?? "" }] : undefined,
    }
  }

  // For arXiv
  async getArXivInfo(arXiv: string) {
    const api = `https://export.arxiv.org/api/query?id_list=${arXiv}`
    let response = await this.requests.get(
      api,
      "application/xhtml+xml"
    )
    if (response) {
      let data = this.parseArXivEntry(response)
      if (data) {
        data.arXiv = arXiv
        return this.Info.arXiv(data)
      }
    }
  }

  // For title
  /**
   * From crossref
   * @param title 
   * @returns 
   */
  async getTitleInfoByCrossref(title: string): Promise<ItemInfo | undefined> {
    const api = `https://api.crossref.org/works?query=${title}`
    let response = await this.requests.get(api)
    if (response) {
      const skipTypes = ["component"]
      let item = response.message.items.filter((e: any) => skipTypes.indexOf(e.type) == -1)[0]
      let info = this.Info.crossref(item) as ItemInfo
      return info
    }
  }

  async getTitleInfoByConnectedpapers(text: string): Promise<ItemInfo | undefined> {
    let title = text
    if (this.utils.isDOI(text)) {
      const paper = await resolveSemanticScholarPaperByDOI(text)
      if (!paper?.title) { return }
      title = paper.title
    }
    const api = `https://rest.connectedpapers.com/search/${escape(title)}/1`
    let response = await this.requests.post(api)
    if (response) {
      if (response?.results?.length) {
        let item = response.results[0]
        let info = this.Info.connectedpapers(item) as ItemInfo
        return info
      }
    }
  }
  
  async getTitleInfoByReadpaper(title: string, body: object = {}, doi: string | undefined = undefined): Promise<ItemInfo|undefined> {
    const api = "https://readpaper.com/api/microService-app-aiKnowledge/aiKnowledge/paper/search"
    let _body = {
      keywords: title,
      page: 1,
      pageSize: 1,
      searchType: Number(Object.values(body).length > 0)
    }
    body = { ..._body, ...body }

    let response = await this.requests.post(api, body)
    if (response && response?.data?.list?.[0]) {
      let data = response?.data?.list?.[0]
      // Verify the DOI
      if (doi) {
        // Fetch the DOI belonging to this paperId
        let _res = await this.requests.post(
          "https://readpaper.com/api/microService-app-aiKnowledge/aiKnowledge/paper/getPaperDetailInfo",
          { paperId: data.id }
        )
        ztoolkit.log(doi, _res.data.doi)
        if (_res.data.doi.toUpperCase() != doi.toUpperCase()) {
          return
        }
      }
      let info = this.Info.readpaper(data) as ItemInfo
      if (doi) { info.identifiers = { DOI: doi }}
      return info
    }
  }

}

export default  API
