/**
 * 面板内状态条。
 *
 * 原先所有状态提示都走 Zotero 的 ProgressWindow，堆在主窗口右下角：操作发生在
 * 侧栏，反馈却出现在屏幕另一头，视线要来回跳，多条并发时还会盖住条目列表。
 * 这里把状态提示搬回 Reference 区块自己的顶部，紧贴标签栏下方。
 *
 * 对外刻意保持和 ProgressWindowHelper 一样的链式 API（createLine / changeLine /
 * changeHeadline / show / startCloseTimer），调用点只需要换构造函数。
 * 找不到可见面板时（比如库视图里没展开区块）自动退回 ProgressWindow，
 * 否则提示会静默丢失。
 */

const NS_XHTML = "http://www.w3.org/1999/xhtml";
const DEFAULT_CLOSE_TIME = 3000;

type StatusType = "default" | "success" | "fail" | string;

interface LineOptions {
  type?: StatusType;
  icon?: string;
  text?: string;
  progress?: number;
  idx?: number;
}

interface StatusOptions {
  window?: Window;
  closeOnClick?: boolean;
  closeTime?: number;
  closeOtherProgressWindows?: boolean;
}

/** 取当前真正显示在用户眼前的那个 Reference 区块。 */
function findVisiblePanel(win?: Window): HTMLElement | undefined {
  const doc = (win ?? (Zotero as any).getMainWindow?.())?.document
    ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) { return; }
  const panels = [...doc.querySelectorAll(".zoference-section")] as HTMLElement[];
  // offsetParent 为 null 表示挂在隐藏的标签页里（阅读器每个 tab 各有一份 item pane）。
  return panels.find((panel) => panel.isConnected && panel.offsetParent !== null)
    ?? panels.find((panel) => panel.isConnected);
}

function create(doc: Document, tag: string, className?: string): HTMLElement {
  const element = doc.createElementNS(NS_XHTML, tag) as HTMLElement;
  if (className) { element.className = className; }
  return element;
}

/** 状态条按需创建：区块会被 Zotero 反复重建，模板里写死反而更容易丢。 */
function ensureBar(panel: HTMLElement): HTMLElement {
  let bar = panel.querySelector(".reference-status") as HTMLElement | null;
  if (bar) { return bar; }
  const doc = panel.ownerDocument;
  bar = create(doc, "div", "reference-status");
  bar.append(
    create(doc, "span", "reference-status-headline"),
    create(doc, "span", "reference-status-text"),
  );
  const progress = create(doc, "div", "reference-status-progress");
  progress.append(create(doc, "div", "reference-status-progress-bar"));
  bar.append(progress);
  const tabs = panel.querySelector(".reference-tabs");
  // 放在标签栏下方：两个标签页共用一条，切页不会让进行中的提示消失。
  if (tabs) { tabs.after(bar); } else { panel.prepend(bar); }
  return bar;
}

/** 当前正在显示的状态条，用来实现 closeOtherProgressWindows / 顶掉旧提示。 */
let active: PanelStatus | undefined;

export class PanelStatus {
  private headline: string;
  private options: StatusOptions;
  private bar?: HTMLElement;
  private fallback?: any;
  private closeTimer?: number;
  private line: LineOptions = {};
  private shown = false;

  constructor(headline: string, options: StatusOptions = {}) {
    this.headline = headline;
    this.options = options;
  }

  createLine(options: LineOptions): this {
    this.line = { ...options };
    this.render();
    return this;
  }

  changeLine(options: LineOptions): this {
    this.line = { ...this.line, ...options };
    this.render();
    return this;
  }

  changeHeadline(text: string): this {
    this.headline = text;
    this.render();
    return this;
  }

  show(closeTime?: number): this {
    const panel = findVisiblePanel(this.options.window);
    if (!panel) {
      // 没有可见面板就退回原来的右下角弹窗，总比什么都不提示强。
      this.fallback = new ztoolkit.ProgressWindow(this.headline, this.options);
      this.fallback.createLine(this.line).show(closeTime);
      return this;
    }
    this.shown = true;
    this.claim(panel);
    const timeout = closeTime ?? this.options.closeTime ?? DEFAULT_CLOSE_TIME;
    // closeTime <= 0 是“我自己管关闭”的约定（长任务用），沿用 ProgressWindow 的语义。
    if (timeout > 0) { this.startCloseTimer(timeout); }
    return this;
  }

  startCloseTimer(closeTime: number = DEFAULT_CLOSE_TIME): this {
    if (this.fallback) {
      this.fallback.startCloseTimer(closeTime);
      return this;
    }
    this.clearTimer();
    const win = this.bar?.ownerDocument?.defaultView;
    if (!win) { return this; }
    this.closeTimer = win.setTimeout(() => this.close(), closeTime);
    return this;
  }

  /** 被别的提示顶掉：让出状态条，但保留“还活着”的身份。 */
  private displace(): void {
    this.clearTimer();
    if (active === this) { active = undefined; }
    this.bar = undefined;
  }

  close(): void {
    this.shown = false;
    this.clearTimer();
    if (this.fallback) {
      this.fallback.close?.();
      this.fallback = undefined;
      return;
    }
    if (active === this) { active = undefined; }
    // 只在这条提示仍是自己渲染的内容时才收起，避免关掉别人刚写上去的提示。
    if (this.bar && (this.bar as any)._owner === this) {
      this.bar.remove();
    }
    this.bar = undefined;
  }

  private clearTimer() {
    if (this.closeTimer === undefined) { return; }
    this.bar?.ownerDocument?.defaultView?.clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /** 占用当前面板的状态条，顶掉上一条提示。 */
  private claim(panel: HTMLElement) {
    // 顶掉别人时用 displace：对方若是仍在跑的长任务，后续消息还能抢回状态条。
    if (active && active !== this) { active.displace(); }
    active = this;
    this.bar = ensureBar(panel);
    this.render();
  }

  private render() {
    // 区块被 Zotero 重建（切条目、刷新列表）后原来的状态条就没了；长任务
    // 后续的 changeLine 得能重新贴回去，否则“进行中”会中途哑掉、再无结果提示。
    if (this.shown && !this.fallback && !this.bar?.isConnected) {
      const panel = findVisiblePanel(this.options.window);
      if (panel) { this.claim(panel); return; }
    }
    const bar = this.bar;
    if (!bar || !bar.isConnected) { return; }
    (bar as any)._owner = this;
    const type = this.line.type || "default";
    bar.dataset.type = type;
    (bar.querySelector(".reference-status-headline") as HTMLElement).textContent =
      this.headline;
    (bar.querySelector(".reference-status-text") as HTMLElement).textContent =
      this.line.text || "";
    const progress = bar.querySelector(".reference-status-progress") as HTMLElement;
    const value = this.line.progress;
    progress.style.display = typeof value === "number" ? "block" : "none";
    if (typeof value === "number") {
      (progress.firstElementChild as HTMLElement).style.width =
        `${Math.max(0, Math.min(100, value))}%`;
    }
  }
}

/**
 * 建一条面板内状态提示。与 `new ztoolkit.ProgressWindow(...)` 调用方式一致。
 */
export function status(headline: string, options: StatusOptions = {}): PanelStatus {
  return new PanelStatus(headline, options);
}

/** 收起当前状态条（对应原来的 `Zotero.ProgressWindowSet.closeAll()`）。 */
export function closeStatus() {
  active?.close();
}
