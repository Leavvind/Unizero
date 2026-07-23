import { PanelStatus } from "./status";
import { config } from "../../package.json";
import Utils from "./utils";

/** #rgb / #rrggbb → [r,g,b]; null when unparseable, so the caller uses a default. */
function parseHex(color: string): [number, number, number] | null {
  const hex = String(color || "").trim().replace(/^#/, "");
  if (hex.length === 3) {
    return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
  }
  if (hex.length === 6) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  return null;
}

/** WCAG relative luminance; decides whether the foreground goes dark or light. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const rgbA = parseHex(a), rgbB = parseHex(b);
  if (!rgbA || !rgbB) { return 21; }
  const [hi, lo] = [luminance(rgbA), luminance(rgbB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Floating-window colours.
 *
 * The background used to be set without a foreground, leaving the text colour
 * inherited from the Zotero theme — which under a dark theme meant white on white,
 * the root cause of the "can't read it" reports. The foreground is now derived
 * from the background's luminance, so it holds under any theme.
 */
function buildTheme(background: string, title: string) {
  const rgb = parseHex(background) || [255, 255, 255];
  const isDark = luminance(rgb) < 0.4;
  const foreground = isDark ? "#f2f3f5" : "#1b1d21";
  // The title colour is user-configured, but blue #2270d9 lacks contrast on a dark
  // background, so fall back to a lighter variant.
  const safeTitle = contrastRatio(title, background) >= 3 ? title : (isDark ? "#7fb2ff" : "#1a5fc0");
  return {
    background,
    foreground,
    muted: isDark ? "#a9b0ba" : "#5c6370",
    title: safeTitle,
  };
}

export default class TipUI {
  private utils: Utils;
  private refRect!: Rect;
  private position!: string;
  public container!: HTMLDivElement;
  public shadeMillisecond!: number;
  public removeTipAfterMillisecond!: number;
  private option = {
    size: 8,
    color: {
      active: "#FF597B",
      default: "#F9B5D0"
    }
  }
  public tipTimer!: number;
  /** Foreground colours derived from the background; readable in light and dark themes. */
  private theme!: { background: string; foreground: string; muted: string; title: string };

  constructor() {
    this.shadeMillisecond = parseInt(Zotero.Prefs.get(`${config.addonRef}.shadeMillisecond`) as string)
    this.removeTipAfterMillisecond = parseInt(Zotero.Prefs.get(`${config.addonRef}.removeTipAfterMillisecond`) as string)
    this.utils = new Utils()
    this.theme = buildTheme(
      Zotero.Prefs.get(`${config.addonRef}.tipBackgroundColor`) as string,
      Zotero.Prefs.get(`${config.addonRef}.tipTitleColor`) as string,
    )
  }

  public onInit(refRect: Rect, position:string) {
    this.refRect = refRect;
    this.position = position;
    // Initialise: remove any other container first.
    this.clear()
    this.buildContainer()
  }

  public clear() {
    document.querySelectorAll(".zoference-tip-container").forEach((e: any) => {
      e.style.opacity = "0"
      window.setTimeout(() => {
        e.remove()
      }, this.shadeMillisecond);
    })
  }
  /**
   * Place the container in a suitable position.
   */
  private place() {
    `
		winRect = {
			bottom: 792
			height: 792
			left: 0
			right: 1536
			top: 0
			width: 1536
			x: 0
			y: 0
		}
		eleRect = {
			bottom: 188
			height: 16
			left: 1196
			right: 1507
			top: 172
			width: 310
			x: 1196
			y: 172
		}
		top-right (x=0, y=0)
		`
    let setStyles = (styles: {[key: string]: string}) => {
      for (let k in styles) {
        this.container.style[k as any] = styles[k]
      }
      return this.container.getBoundingClientRect() as Rect
    }
    const winRect: Rect = document.documentElement.getBoundingClientRect()
    const maxWidth = winRect.width;
    const maxHeight = winRect.height;
    const refRect = this.refRect;
    // An abstract is long prose, and a line past ~90 characters is hard to read;
    // on a wide screen the proportional calculation stretches to a thousand-odd
    // pixels — the screen-wide white bar seen in the screenshots — so an absolute
    // cap sits on top of the proportion.
    const MAX_TIP_WIDTH = 560;
    const clampWidth = (width: number) => Math.max(280, Math.min(width, MAX_TIP_WIDTH, maxWidth - 60));

    // Left side
    let styles: any
    if (this.position == "left") {
      styles = {
        // right: `${maxWidth - refRect.x + maxWidth * .014}px`,
        right: `${maxWidth - refRect.x}px`,

        bottom: "",
        top: `${refRect.y}px`,
        width: `${clampWidth(refRect.x * .7)}px`
      }
    } else if (this.position == "top center") {
      let width = clampWidth(maxWidth * .7)
      styles = {
        width: `${width}px`,
        left: `${refRect.x + refRect.width / 2 - width / 2}px`,
        bottom: `${maxHeight - refRect.y}px`,
        top: "",
      }
      this.container.style.flexDirection = "column-reverse"
    }
    let rect = setStyles(styles)
    // Check whether it overflows the window.
    if (rect.bottom > maxHeight) {
      setStyles({
        top: "",
        bottom: "0px",
      })
      this.container.style.flexDirection = "column-reverse"
    }
    if (rect.top < 0) {
      setStyles({
        bottom: "",
        top: "0px",
      })
    }
    if (rect.left < 30) {
      setStyles({
        right: "",
        left: "30px"
      })
    }
    if (maxWidth - rect.right < 30 ) {
      setStyles({
        left: "",
        right: "30px"
      })
    }
    this.container.style.opacity = "1";
    return
  }

  private buildContainer() {
    // Position calculation
    this.container = ztoolkit.UI.createElement(
      document,
      "div",
      {
        namespace: "html",
        classList: ["zoference-tip-container"],
        styles: {
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          position: "fixed",
          zIndex: "999",
          // border: "2px solid transparent",
          padding: "1em 1.15em",
          backgroundColor: this.theme.background,
          color: this.theme.foreground,
          // The border separates the tooltip from the PDF or list background on
          // both light and dark surfaces.
          border: "1px solid rgb(128 128 128 / 35%)",
          fontSize: "13px",
          lineHeight: "1.5",
          opacity: "0",
          transition: `opacity ${this.shadeMillisecond / 1000}s linear`,
          "-moz-user-select": "text",
          boxShadow: "0 6px 28px rgb(0 0 0 / 28%)",
          borderRadius: "8px",

        } as any,
        listeners: [
          {
            type: "DOMMouseScroll",
            listener: (event: any) => {
              if (event.ctrlKey) { this.zoom(event); }
            }
          },
          {
            type: "mouseenter",
            listener: () => {
              window.clearTimeout(this.tipTimer);
            }
          },
          {
            type: "mouseleave",
            listener: () => {
              this.tipTimer = window.setTimeout(() => {
                this.container.remove();
              }, this.removeTipAfterMillisecond);
            }
          }
        ],
        children: [
          {
            tag: "box",
            id: "option-container",
            styles: {
              width: "100%",
              height: `${this.option.size}px`,
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: ".25em",
              marginTop: ".25em"
            },
          },
          {
            tag: "box",
            id: "content-container",
            styles: {
              width: "100%"
            }
          }
        ]
      }
    ) as unknown as HTMLDivElement
    document.documentElement.appendChild(this.container)
  }

  /**
   * @param title the title
   * @param tags the tags
   * @param descriptions description lines, usually venue, year, and authors
   * @param content the body, usually the abstract
   * @param titleURL link behind the title; clicking opens it in the browser
   * @returns
   */
  public addTip(
    title: string,
    tags: { source: string; text: string, color: string, tip?: string, url?: string, item?: Zotero.Item }[],
    descriptions: string[],
    content: string,
    according: string,
    index: number,
    prefIndex?: number,
    titleURL?: string
  ) {
    const translate = async (text: string) => {
      if (Zotero.ZoteroPDFTranslate) {
        Zotero.ZoteroPDFTranslate._sourceText = text
        const success = await Zotero.ZoteroPDFTranslate.translate.getTranslation()
        if (!success) {
          Zotero.ZoteroPDFTranslate.view.showProgressWindow(
            "Translate Failed",
            success,
            "fail"
          );
          return
        }
        return Zotero.ZoteroPDFTranslate._translatedText;
      } else if (Zotero.PDFTranslate) {
        return (await Zotero.PDFTranslate.api.translate(text))?.result
      }
    }
    let translateNode = async function (event: any) {
      if (
        (
          (Zotero.isMac && event.metaKey && !event.ctrlKey) ||
          (!Zotero.isMac && event.ctrlKey)
        ) &&
        Zotero.Prefs.get(`${config.addonRef}.ctrlClickTranslate`)
      ) {
        // @ts-ignore
        let node = this as HTMLElement
        let sourceText = node.getAttribute("sourceText")
        let translatedText = node.getAttribute("translatedText")!
        ztoolkit.log(sourceText, translatedText)
        if (!sourceText) {
          sourceText = node.innerText;
          node.setAttribute("sourceText", sourceText)
        }
        if (!translatedText) {
          translatedText = await translate(sourceText)
          node.setAttribute("translatedText", translatedText)
        }

        if (node.innerText == sourceText) {
          ztoolkit.log("-> translatedText")
          node.innerText = translatedText
        } else if (node.innerText == translatedText) {
          node.innerText = sourceText
          ztoolkit.log("-> sourceText")
        }
      }
    }
    const isSelect = (
      (index !== undefined && prefIndex !== undefined && index == prefIndex) ||
      this.container.querySelector("#option-container")!.childNodes.length == 0
    )
    if (isSelect) { this.reset() }
    const contentNode = ztoolkit.UI.createElement(
      document,
      "div",
      {
        classList: ["zoference-tip"],
        styles: {
          padding: "0px",
          width: "100%",
          display: isSelect ? "" : "none"
        },
        subElementOptions: [
          {
            tag: "span",
            classList: ["title"],
            styles: {
              display: "block",
              fontWeight: "600",
              marginBottom: ".35em",
              fontSize: "1.15em",
              lineHeight: "1.35",
              color: this.theme.title,
              cursor: titleURL ? "pointer" : "",
              textDecoration: titleURL ? "underline" : "",
              textDecorationStyle: titleURL ? "dotted" : "",
              textUnderlineOffset: "3px"
            },
            directAttributes: {
              innerText: title
            },
            attributes: titleURL ? { title: titleURL } : {},
            listeners: [
              {
                type: "click",
                listener: translateNode
              },
              // A plain click opens the link; ctrl/cmd-click still translates.
              // translateNode checks the modifier itself, and the two listeners'
              // conditions are mutually exclusive, so one click never both
              // translates and navigates.
              {
                type: "click",
                listener: (event: any) => {
                  if (!titleURL) { return }
                  if (Zotero.isMac ? event.metaKey : event.ctrlKey) { return }
                  Zotero.ProgressWindowSet.closeAll();
                  (new PanelStatus("Launching URL"))
                    .createLine({ text: titleURL, type: "default" })
                    .show()
                  Zotero.launchURL(titleURL)
                }
              }
            ]
          },
          ...(tags && tags.length > 0 ? [{
            tag: "div",
            id: "tags",
            styles: {
              width: "100%",
              // margin: "0.5em 0",
            },
            subElementOptions: ((tags) => {
              if (!tags) { return [] }
              let arr = []
              for (let tag of tags) {
                arr.push({
                  tag: "span",
                  directAttributes: {
                    innerText: tag.text
                  },
                  styles: {
                    backgroundColor: tag.color,
                    borderRadius: "10px",
                    margin: "0.5em 1em 0.5em 0px",
                    display: "inline-block",
                    padding: "0 8px",
                    color: "white",
                    cursor: "pointer",
                    userSelect: "none"
                  },
                  listeners: [
                    {
                      type: "click",
                      listener: () => {
                        if (tag.url) {
                          (new PanelStatus("Launching URL"))
                            .createLine({ text: tag.url, type: "default"})
                            .show()
                          Zotero.launchURL(tag.url);
                        } else if (tag.item) {
                          this.clear()
                          Zotero.ProgressWindowSet.closeAll();
                          this.utils.selectItemInLibrary(tag.item)
                        }
                        else {
                          this.utils.copyText(tag.text)
                        }
                      }
                    },
                    {
                      type: "mouseenter",
                      listener: () => {
                        if (!tag.tip) { return }
                        Zotero.ProgressWindowSet.closeAll();
                        (new ztoolkit.ProgressWindow("Reference", { closeTime: -1 }))
                          .createLine({ text: tag.tip, type: "default" })
                          .show()
                      }
                    },
                    {
                      type: "mouseleave",
                      listener: () => {
                        if (!tag.tip) { return }
                        Zotero.ProgressWindowSet.closeAll();
                      }
                    }
                  ]
                })
              }
              return arr
            })(tags) as any
          }] : []),
          ...(descriptions && descriptions.length > 0 ? [{
            tag: "div",
            id: "descriptions",
            styles: {
              marginBottom: "0.25em"
            },
            children: ((descriptions) => {
              if (!descriptions) { return [] }
              let arr = [];
              for (let text of descriptions) {
                arr.push({
                  tag: "span",
                  id: "content",
                  styles: {
                    display: "block",
                    lineHeight: "1.5em",
                    // A solid muted colour rather than opacity: 0.5 opacity over a
                    // light background all but disappears.
                    color: this.theme.muted,
                    cursor: "pointer",
                    userSelect: "none"
                  },
                  properties: {
                    innerText: text
                  },
                  listeners: [
                    {
                      type: "click",
                      listener: () => {
                        this.utils.copyText(text)
                      }
                    }
                  ]
                })
              }
              return arr
            })(descriptions) as any
          }] : []),
          {
            tag: "span",
            id: "content",
            properties: {
              innerText: content
            },
            styles: {
              display: "block",
              lineHeight: "1.6em",
              textAlign: "left",
              color: this.theme.foreground,
              maxHeight: "300px",
              overflowY: "auto",
              marginTop: ".4em"
            },
            listeners: [
              {
                type: "click",
                listener: translateNode
              }
            ]
          }
        ]
      }
    ) as HTMLDivElement
    const optionNode = ztoolkit.UI.createElement(
      document,
      "div",
      {
        id: `option-${index}`,
        styles: {
          width: `${this.option.size}px`,
          height: `${this.option.size}px`,
          borderRadius: "50%",
          backgroundColor: isSelect ? this.option.color.active : this.option.color.default,
          marginLeft: `${this.option.size * .5}px`,
          marginRight: `${this.option.size * .5}px`,
          cursor: "pointer",
          transition: "background-color 0.23s linear"
        },
        listeners: [
          {
            type: "click",
            listener: () => {
              this.reset()
              optionNode.style.backgroundColor = this.option.color.active
              contentNode.style.display = ""
              Zotero.Prefs.set(`${config.addonRef}.${according}InfoIndex`, index!)
              this.place()
            },
          },
          {
            type: "mouseenter",
            listener: () => {
              let tag = tags.find(tag => tag.source)
              let source = (
                (tag && tag.source && according && `${tag.source} view according to ${according}`) ||
                "reference view"
              )
              Zotero.ProgressWindowSet.closeAll();
              (new ztoolkit.ProgressWindow("Reference", {closeTime: -1}))
                .createLine({ text: source, type: "default" })
                .show()
            }
          },
          {
            type: "mouseleave",
            listener: () => {
              Zotero.ProgressWindowSet.closeAll();
            }
          }
        ]
      }
    ) as HTMLDivElement
    const optionContainer = this.container.querySelector("#option-container")!;
    const optionNodes = [...optionContainer.querySelectorAll("[id^=option]")] as HTMLElement[]
    if (optionNodes.length == 0) {
      optionContainer.appendChild(optionNode)
    } else {
      let getIndex = (node: HTMLElement) => Number(node.id.split("-")[1])
      for (let i = 0; i < optionNodes.length; i++) {
        if (index > getIndex(optionNodes[i])) {
          if (i + 1 < optionNodes.length) {
            if (index < getIndex(optionNodes[i + 1])) {
              optionContainer.insertBefore(optionNode, optionNodes[i + 1])
              break
            }
          } else {
            optionContainer.appendChild(optionNode)
            break
          }
        } else {
          optionContainer.insertBefore(optionNode, optionNodes[i])
          break
        }
      }
    }
    this.container.querySelector("#content-container")!.appendChild(contentNode)
    this.place()
  }

  private reset() {
    this.container.querySelector("#content-container")!
      .childNodes
      .forEach((e: any) => {
        e.style.display = "none"
      })
    this.container.querySelector("#option-container")!
      .childNodes
      .forEach((e: any) => {
        e.style.backgroundColor = this.option.color.default
      })
  }

  private zoom(event: any) {
    let _scale = this.container.style.transform.match(/scale\((.+)\)/)
    let scale = _scale ? parseFloat(_scale[1]) : 1
    let minScale = 1, maxScale = 1.7, step = 0.05
    if (this.container.style.bottom == "0px") {
      this.container.style.transformOrigin = "center bottom"
    } else {
      this.container.style.transformOrigin = "center center"
    }
    if (event.detail > 0) {
      // Zoom out
      scale = scale - step
      this.container.style.transform = `scale(${scale < minScale ? minScale : scale})`;
    } else {
      // Zoom in
      scale = scale + step
      this.container.style.transform = `scale(${scale > maxScale ? maxScale : scale})`;
    }
  }
}