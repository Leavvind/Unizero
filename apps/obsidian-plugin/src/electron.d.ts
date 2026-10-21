/**
 * The sliver of Electron this plugin uses.
 *
 * Obsidian provides the module at runtime and the bundler treats it as external,
 * so declaring only what is called here avoids pulling in Electron's full types
 * for two functions. The manifest is `isDesktopOnly` for this reason.
 */
declare module "electron" {
  export const shell: {
    openExternal(url: string): Promise<void>;
    /** Resolves to an error message, or "" on success. */
    openPath(path: string): Promise<string>;
  };
}
