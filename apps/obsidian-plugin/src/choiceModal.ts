import { Modal, Setting, type App } from "obsidian";

export interface Choice<T> {
  label: string;
  value: T;
  /** The suggested choice (accent button). */
  cta?: boolean;
  /** A choice that moves something to the trash (warning button). */
  warning?: boolean;
}

/**
 * Ask the user to pick one of a few actions. Resolves once, with the chosen value
 * or undefined when the dialog is dismissed.
 */
export function choose<T>(
  app: App,
  options: { title: string; message: string; choices: Choice<T>[] },
): Promise<T | undefined> {
  return new Promise((resolve) => {
    new ChoiceModal(app, options, resolve).open();
  });
}

/** Yes/no confirmation for an action that changes Zotero. */
export async function confirm(
  app: App,
  options: { title: string; message: string; action: string; warning?: boolean },
): Promise<boolean> {
  const picked = await choose(app, {
    title: options.title,
    message: options.message,
    choices: [
      { label: "Cancel", value: false },
      { label: options.action, value: true, cta: !options.warning, warning: options.warning },
    ],
  });
  return picked === true;
}

class ChoiceModal<T> extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: { title: string; message: string; choices: Choice<T>[] },
    private readonly resolve: (value: T | undefined) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    for (const paragraph of this.options.message.split("\n\n")) {
      this.contentEl.createEl("p", { text: paragraph });
    }
    const buttons = new Setting(this.contentEl);
    for (const choice of this.options.choices) {
      buttons.addButton((button) => {
        button.setButtonText(choice.label).onClick(() => this.finish(choice.value));
        if (choice.cta) { button.setCta(); }
        if (choice.warning) { button.setWarning(); }
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(undefined);
  }

  private finish(value: T | undefined): void {
    if (this.settled) { return; }
    this.settled = true;
    this.resolve(value);
    if (value !== undefined) { this.close(); }
  }
}
