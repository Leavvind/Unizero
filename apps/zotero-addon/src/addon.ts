import type { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import type { UniConnection } from "./modules/uniConnection";
import type { UniConnectionSync } from "./modules/uniConnectionSync";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    // Env type, see build.js
    env: "development" | "production";
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
      default?: any;
    };
    prefs?: {
      window: Window;
      columns?: Array<ColumnOptions>;
      rows?: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
    metadataEnrichment?: {
      register(win: Window): void;
      unregister(win: Window): void;
      unregisterAll(): void;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: {
    uniConnection?: UniConnection;
    uniConnectionSync?: UniConnectionSync;
  };

  constructor() {
    this.data = {
      alive: true,
      env: __env__,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
