import { getSemanticScholarKey } from "./scholarlyHttp";

export default class Requests {
  /**
   * Record api response
   */
  public cache: { [key: string]: any } = {}

  async get(url: string, responseType: string = "json", headers: object = {}) {
    const k = JSON.stringify(arguments)
    if (this.cache[k]) {
      return this.cache[k]
    }
    // Inject the S2 key here rather than at every call site: api.ts makes several
    // semanticscholar requests, changing them one by one is easy to get wrong, and
    // a single miss means a user with a key is still rate-limited as anonymous.
    const key = getSemanticScholarKey()
    if (key && /^https:\/\/api\.semanticscholar\.org\//i.test(url)) {
      headers = { ...headers, "x-api-key": key }
    }
    let res = await Zotero.HTTP.request(
      "GET",
      url,
      {
        responseType: responseType,
        headers
      }
    )
    if (res.status == 200) {
      this.cache[k] = res.response
      return res.response
    } else {
      ztoolkit.log(`get ${url} error`, res)
    }
  }

  async post(url: string, body: object = {}, responseType: string = "json") {
    const k = JSON.stringify(arguments)
    if (this.cache[k]) {
      return this.cache[k]
    }
    let res = await Zotero.HTTP.request(
      "POST",
      url,
      Object.assign({
        responseType: responseType,
      }, (Object.keys(body).length > 0 ? {
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        // credentials: "include"
      } : {}))
    )
    if (res.status == 200) {
      this.cache[k] = res.response
      return res.response
    } else {
      // window.alert("error" + res.status)
      ztoolkit.log(`post ${url} error`, res)
    }
  }
}
