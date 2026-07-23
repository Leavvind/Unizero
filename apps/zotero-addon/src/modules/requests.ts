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
    // 在这里注入 S2 key 而不是在每个调用点：api.ts 里散着好几处 semanticscholar 请求，
    // 逐个改容易漏，漏一处就等于用户配了 key 还在被匿名限流。
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
