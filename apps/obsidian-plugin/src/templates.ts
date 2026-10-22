import type { BridgeTemplates } from "./bridge";

/** One row of the "convert with template" menu, free of Obsidian for testing. */
export interface TemplateMenuEntry {
  title: string;
  /** Sent as the convert request's `template`; "" lets Zotero pick its default. */
  template?: string;
  checked: boolean;
  disabled: boolean;
}

/**
 * Rows for the template chooser.
 *
 * `defaultTemplate` is the user's setting ("" = Zotero's default) and is the
 * checked row. A stopped runtime has no list; the default stays available so a
 * conversion can still be started, which launches the runtime in Zotero.
 */
export function templateMenuEntries(
  listed: BridgeTemplates,
  defaultTemplate: string,
): TemplateMenuEntry[] {
  const preferred = defaultTemplate || listed.defaultTemplate;
  if (!listed.available) {
    return [
      {
        title: "Templates appear once the paper runtime runs",
        checked: false,
        disabled: true,
      },
      {
        title: `Convert with default (${preferred})`,
        template: defaultTemplate,
        checked: false,
        disabled: false,
      },
    ];
  }
  return listed.templates.map((template) => ({
    title: template.name || template.id,
    template: template.id,
    checked: template.id === preferred,
    disabled: false,
  }));
}
