/**
 * Static feature lifecycle registry.
 *
 * Feature code remains compiled into the XPI. The registry provides one auditable
 * activation/deactivation path; it is not a third-party module loader.
 */

export interface FeatureModule {
  readonly id: string;
  onWindowLoad?(win: Window): void | Promise<void>;
  onWindowUnload?(win: Window): void | Promise<void>;
  onAppShutdown?(): void;
  onShutdown?(): void | Promise<void>;
}

export class FeatureRegistry {
  private readonly modules: FeatureModule[];
  private readonly windows = new Map<Window, Set<string>>();

  constructor(modules: FeatureModule[]) {
    const ids = new Set<string>();
    for (const module of modules) {
      if (ids.has(module.id)) {
        throw new Error(`duplicate feature module '${module.id}'`);
      }
      ids.add(module.id);
    }
    this.modules = [...modules];
  }

  list(): readonly FeatureModule[] {
    return this.modules;
  }

  async onWindowLoad(win: Window): Promise<void> {
    const active = this.windows.get(win) || new Set<string>();
    this.windows.set(win, active);
    for (const module of this.modules) {
      if (active.has(module.id)) { continue; }
      if (await this.invoke(module, "onWindowLoad", win)) {
        active.add(module.id);
      }
    }
  }

  async onWindowUnload(win: Window): Promise<void> {
    const active = this.windows.get(win);
    if (!active) { return; }
    this.windows.delete(win);
    for (const module of [...this.modules].reverse()) {
      if (active.has(module.id)) {
        await this.invoke(module, "onWindowUnload", win);
      }
    }
  }

  onAppShutdown(): void {
    for (const module of [...this.modules].reverse()) {
      try {
        module.onAppShutdown?.();
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
  }

  async onShutdown(): Promise<void> {
    for (const win of [...this.windows.keys()]) {
      await this.onWindowUnload(win);
    }
    for (const module of [...this.modules].reverse()) {
      await this.invoke(module, "onShutdown");
    }
  }

  private async invoke(
    module: FeatureModule,
    hook: "onWindowLoad" | "onWindowUnload" | "onShutdown",
    win?: Window,
  ): Promise<boolean> {
    try {
      const handler = module[hook] as
        | ((window?: Window) => void | Promise<void>)
        | undefined;
      await handler?.(win);
      return true;
    } catch (error) {
      ztoolkit.log(`[feature:${module.id}] ${hook} failed`, error);
      Zotero.logError(error as Error);
      return false;
    }
  }
}
