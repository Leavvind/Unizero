/** UniZero panel: service status, jobs, and YAML-backed template editor. */

"use strict";

var api = window.arguments[0].api;

var Panel = {
  timer: null,
  online: false,
  serverCfgLoaded: false,
  templatesLoaded: false,
  busy: false,
  templates: [],
  moduleDefs: {},
  current: null,
  currentDocument: null,
  selectedStep: -1,
  removedSettings: {},

  init() {
    document.getElementById("btn-start").addEventListener("click", () => this.onStart());
    document.getElementById("btn-stop").addEventListener("click", () => this.onStop());
    document.getElementById("btn-refresh").addEventListener("click", () => this.refresh());
    document.getElementById("btn-settings").addEventListener("click", () => this.openSettings());
    document.getElementById("btn-settings-close").addEventListener("click", () => this.closeSettings());
    document.getElementById("settings-overlay").addEventListener("click", (event) => {
      if (event.target.id === "settings-overlay") this.closeSettings();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeSettings();
    });
    document.getElementById("btn-save-server").addEventListener("click", () => this.saveServerConfig());
    document.getElementById("btn-reload-server").addEventListener("click", () => {
      this.serverCfgLoaded = false;
      this.refresh();
    });
    document.getElementById("btn-template-save").addEventListener("click", () => this.saveTemplate());
    document.getElementById("btn-template-reload").addEventListener("click", () => this.reloadTemplate());
    document.getElementById("btn-template-duplicate").addEventListener("click", () => this.duplicateTemplate());
    document.getElementById("btn-template-reset").addEventListener("click", () => this.resetTemplate());
    document.getElementById("btn-yaml-apply").addEventListener("click", () => this.applyYaml());
    document.getElementById("s-output-root").addEventListener("input", () => {
      let step = this.current && this.current.modules[this.selectedStep];
      if (step && step.module === "publish.markdown-directory") this.updatePublishPreview(step);
    });
    document.getElementById("template-name").addEventListener("input", (event) => {
      if (this.current) this.current.name = event.target.value;
    });
    document.getElementById("template-description").addEventListener("input", (event) => {
      if (this.current) this.current.description = event.target.value;
    });
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 2000);
    window.addEventListener("unload", () => clearInterval(this.timer));
  },

  clone(value) {
    return JSON.parse(JSON.stringify(value));
  },

  // This overlay now holds only the server-side directories (stored in the runtime's
  // config.json). Zotero preferences all live under Settings → UniZero. The element
  // ids are still settings-*, which is this dialog's internal naming and carries no
  // external meaning.
  openSettings() {
    document.getElementById("settings-overlay").hidden = false;
    document.getElementById("btn-settings-close").focus();
  },

  closeSettings() {
    document.getElementById("settings-overlay").hidden = true;
  },

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      let health = null;
      try { health = await api.client.health(); } catch (error) {}
      this.online = !!(health && health.ok);
      this.renderStatus(health);
      document.getElementById("server-offline").style.display = this.online ? "none" : "block";
      document.getElementById("templates-offline").style.display = this.online ? "none" : "block";

      if (this.online) {
        try { this.renderJobs(await api.client.jobs()); } catch (error) {}
        if (!this.serverCfgLoaded) {
          try {
            let response = await api.client.config();
            this.loadServerForm(response.config, response.config_path);
            this.serverCfgLoaded = true;
          } catch (error) {}
        }
        if (!this.templatesLoaded) {
          try { await this.loadTemplateCatalog(); } catch (error) {
            document.getElementById("template-validation").textContent = "Failed to load templates: " + error;
          }
        }
      }
    } finally {
      this.busy = false;
    }
  },

  renderStatus(health) {
    let dot = document.getElementById("status-dot");
    let text = document.getElementById("status-text");
    let detail = document.getElementById("status-detail");
    if (this.online) {
      dot.className = "dot ok";
      let ver = health.mineru_version ? "MinerU " + health.mineru_version : "MinerU version unknown";
      text.textContent = "Running (" + ver + (health.queued ? ", queued " + health.queued : "") + ")";
      detail.textContent = health.vault_configured === false
        ? "No default output base directory set; not required when Publish uses absolute paths  |  " + api.serviceURL()
        : "Default output base directory: " + health.vault + "  |  " + api.serviceURL();
    } else {
      dot.className = "dot bad";
      text.textContent = "Not running";
      detail.textContent = api.serviceURL() + " — click to start, or let a conversion start it";
    }
    document.getElementById("btn-start").disabled = this.online;
    document.getElementById("btn-stop").disabled = !this.online;
  },

  renderJobs(jobs) {
    let empty = document.getElementById("jobs-empty");
    let table = document.getElementById("jobs-table");
    let body = document.getElementById("jobs-body");
    if (!jobs || !jobs.length) {
      empty.style.display = "block";
      table.style.display = "none";
      return;
    }
    empty.style.display = "none";
    table.style.display = "table";
    body.textContent = "";
    const labels = { queued: "Queued", running: "Converting", done: "Done", failed: "Failed" };
    for (let job of jobs) {
      let row = document.createElement("tr");
      let time = document.createElement("td");
      time.textContent = new Date(job.created * 1000).toLocaleTimeString("zh-CN", { hour12: false });
      row.appendChild(time);
      let title = document.createElement("td");
      title.textContent = job.title || "(untitled)";
      row.appendChild(title);
      let status = document.createElement("td");
      status.className = "status " + job.status;
      status.textContent = labels[job.status] || job.status;
      row.appendChild(status);
      let info = document.createElement("td");
      info.textContent = job.error || job.last_log || (job.md_path ? job.md_path.split(/[\\/]/).pop() : "");
      row.appendChild(info);
      body.appendChild(row);
    }
  },

  async onStart() {
    document.getElementById("btn-start").disabled = true;
    try { await api.ensureService(); } finally {
      this.serverCfgLoaded = false;
      this.templatesLoaded = false;
      this.refresh();
    }
  },

  async onStop() {
    let active = false;
    try {
      let jobs = await api.client.jobs();
      active = jobs.some((job) => job.status === "running" || job.status === "queued");
    } catch (error) {}
    if (active && !window.confirm("Jobs are still converting or queued. Stop the service anyway?")) return;
    await api.stopService();
    this.serverCfgLoaded = false;
    this.templatesLoaded = false;
    this.refresh();
  },

  loadServerForm(config, path) {
    document.getElementById("s-output-root").value = config.vault_root || "";
    document.getElementById("s-work").value = config.work_dir || "";
    document.getElementById("server-cfg-path").textContent = path ? "Stored at " + path : "";
  },

  async saveServerConfig() {
    if (!this.online) return window.alert("Start the service first.");
    try {
      let response = await api.client.saveConfig({
        vault_root: document.getElementById("s-output-root").value.trim(),
        work_dir: document.getElementById("s-work").value.trim(),
      });
      this.loadServerForm(response.config, response.config_path);
      let step = this.current && this.current.modules[this.selectedStep];
      if (step && step.module === "publish.markdown-directory") this.updatePublishPreview(step);
      this.flash("server-saved");
    } catch (error) { window.alert("Save failed: " + error); }
  },

  async loadTemplateCatalog(preferredId) {
    let responses = await Promise.all([api.client.modules(), api.client.templates()]);
    this.moduleDefs = {};
    for (let definition of responses[0].modules || []) this.moduleDefs[definition.id] = definition;
    this.templates = responses[1].templates || [];
    let previous = preferredId || (this.current && this.current.id) || "";
    this.renderModuleAddOptions();
    this.templatesLoaded = true;
    let target = this.templates.some((item) => item.id === previous)
      ? previous : this.templates.length ? this.templates[0].id : "";
    if (target) {
      await this.loadTemplate(target);
    } else {
      this.renderTemplateTabs();
    }
  },

  renderTemplateTabs() {
    let host = document.getElementById("template-tabs");
    host.textContent = "";
    for (let template of this.templates) {
      let button = document.createElement("button");
      button.className = "template-tab" + (
        this.current && template.id === this.current.id ? " active" : ""
      );
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", this.current && template.id === this.current.id ? "true" : "false");
      button.textContent = template.name + (template.customized ? " · modified" : "");
      button.title = template.description || template.id;
      button.addEventListener("click", () => this.loadTemplate(template.id));
      host.appendChild(button);
    }
  },

  async loadTemplate(templateId) {
    if (!templateId) return;
    let documentValue = await api.client.template(templateId);
    this.currentDocument = documentValue;
    this.current = this.clone(documentValue.template);
    this.removedSettings = {};
    this.selectedStep = this.current.modules.length ? 0 : -1;
    this.renderTemplate();
  },

  renderTemplate() {
    if (!this.current) return;
    this.renderTemplateTabs();
    document.getElementById("template-name").value = this.current.name || "";
    document.getElementById("template-description").value = this.current.description || "";
    document.getElementById("template-yaml").value = this.currentDocument ? this.currentDocument.yaml : "";
    let origin = this.currentDocument && this.currentDocument.customized
      ? "User override of a built-in template" : this.currentDocument && this.currentDocument.builtin
        ? "Built-in template" : "User template";
    document.getElementById("template-origin").textContent = origin + " · " + this.current.id;
    this.renderSteps();
  },

  moduleDefinition(step) {
    return step ? this.moduleDefs[step.module] : null;
  },

  renderSteps() {
    let host = document.getElementById("template-steps");
    host.textContent = "";
    if (!this.current) return;
    this.current.modules.forEach((step, index) => {
      let definition = this.moduleDefinition(step) || { name: step.module, role: "?" };
      let card = document.createElement("div");
      card.className = "step" + (index === this.selectedStep ? " selected" : "");
      card.addEventListener("click", () => { this.selectedStep = index; this.renderSteps(); });
      let required = definition.role === "extract" || definition.role === "publish";
      let label = document.createElement("div");
      label.innerHTML = "<div class='step-name'></div><div class='step-meta'><span class='role-badge'></span><span class='step-id'></span></div>";
      label.children[0].textContent = definition.name
        + (step.enabled === false ? " (disabled, see YAML)" : "");
      let roleLabels = { prepare: "Prepare", extract: "Extract", process: "Process", publish: "Publish" };
      label.children[1].children[0].textContent = roleLabels[definition.role] || definition.role;
      label.children[1].children[1].textContent = step.id;
      label.title = step.module;
      card.appendChild(label);
      let buttons = document.createElement("div");
      buttons.className = "step-buttons";
      let up = this.smallButton("↑", () => this.moveStep(index, -1));
      let down = this.smallButton("↓", () => this.moveStep(index, 1));
      up.disabled = index === 0; down.disabled = index === this.current.modules.length - 1;
      buttons.appendChild(up); buttons.appendChild(down);
      if (!required) buttons.appendChild(this.smallButton("×", () => this.removeStep(index), "danger"));
      card.appendChild(buttons);
      host.appendChild(card);
    });
    this.renderModuleAddOptions();
    this.renderSettings();
  },

  smallButton(text, callback, className) {
    let button = document.createElement("button");
    button.textContent = text;
    if (className) button.className = className;
    button.addEventListener("click", (event) => { event.stopPropagation(); callback(); });
    return button;
  },

  moveStep(index, offset) {
    let target = index + offset;
    if (!this.current || target < 0 || target >= this.current.modules.length) return;
    let item = this.current.modules.splice(index, 1)[0];
    this.current.modules.splice(target, 0, item);
    this.selectedStep = target;
    this.renderSteps();
  },

  removeStep(index) {
    // A removed module returns to the available list; re-adding it within this
    // session restores its settings.
    let removed = this.current.modules.splice(index, 1)[0];
    if (removed) this.removedSettings[removed.module] = this.clone(removed.settings || {});
    this.selectedStep = Math.min(index, this.current.modules.length - 1);
    this.renderSteps();
  },

  renderModuleAddOptions() {
    let host = document.getElementById("module-add-options");
    host.textContent = "";
    let used = new Set(
      this.current ? this.current.modules.map((item) => item.module) : [],
    );
    let available = Object.values(this.moduleDefs).filter(
      (definition) => definition.role !== "extract" && definition.role !== "publish"
        && !used.has(definition.id),
    );
    if (!available.length) {
      let hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Every available module is already in the run list.";
      host.appendChild(hint);
      return;
    }
    for (let definition of available) {
      let button = document.createElement("button");
      button.textContent = "+ " + definition.name;
      button.title = definition.description || definition.id;
      button.addEventListener("click", () => this.addModule(definition.id));
      host.appendChild(button);
    }
  },

  addModule(moduleId) {
    if (!this.current) return;
    let definition = this.moduleDefs[moduleId];
    if (!definition) return;
    let base = moduleId.split(".").pop().replace(/[^a-z0-9-]/g, "-");
    let instanceId = base;
    let number = 2;
    while (this.current.modules.some((item) => item.id === instanceId)) instanceId = base + "-" + number++;
    let publishIndex = this.current.modules.findIndex((item) => {
      let itemDefinition = this.moduleDefinition(item);
      return itemDefinition && itemDefinition.role === "publish";
    });
    let settings = this.removedSettings[moduleId]
      ? this.clone(this.removedSettings[moduleId])
      : this.clone(definition.defaults || {});
    let item = { id: instanceId, module: moduleId, enabled: true, settings: settings };
    let extractIndex = this.current.modules.findIndex((existing) => {
      let itemDefinition = this.moduleDefinition(existing);
      return itemDefinition && itemDefinition.role === "extract";
    });
    let index = definition.role === "prepare"
      ? (extractIndex < 0 ? 0 : extractIndex)
      : (publishIndex < 0 ? this.current.modules.length : publishIndex);
    this.current.modules.splice(index, 0, item);
    this.selectedStep = index;
    this.renderSteps();
  },

  getPath(root, path) {
    let value = root;
    for (let key of path) value = value && value[key] !== undefined ? value[key] : undefined;
    return value;
  },

  setPath(root, path, value) {
    let target = root;
    for (let index = 0; index < path.length - 1; index++) {
      if (!target[path[index]] || typeof target[path[index]] !== "object") target[path[index]] = {};
      target = target[path[index]];
    }
    target[path[path.length - 1]] = value;
  },

  renderSettings() {
    let host = document.getElementById("module-settings");
    host.textContent = "";
    let step = this.current && this.current.modules[this.selectedStep];
    let definition = this.moduleDefinition(step);
    if (!step || !definition) {
      host.className = "hint";
      host.textContent = "Select a module to configure it.";
      return;
    }
    host.className = "";
    document.getElementById("settings-title").textContent = definition.name;
    let description = document.createElement("div");
    description.className = "module-description";
    description.textContent = definition.description || "";
    host.appendChild(description);
    let form = document.createElement("div");
    form.className = "settings-form";
    host.appendChild(form);
    let schema = definition.settings_schema || { type: "object", properties: {} };
    this.appendSchemaFields(form, schema, step.settings, []);
    if (!Object.keys(schema.properties || {}).length) {
      form.textContent = "This module has no adjustable settings.";
      form.className = "hint";
    }
    if (step.module === "publish.markdown-directory") this.appendPublishPreview(host, step);
  },

  appendSchemaFields(host, schema, settings, prefix) {
    for (let [key, field] of Object.entries(schema.properties || {})) {
      let path = prefix.concat([key]);
      let value = this.getPath(settings, path);
      if (field.type === "object" && field.properties) {
        let group = document.createElement("div");
        group.className = "setting-group";
        let title = document.createElement("div");
        title.className = "setting-group-title";
        title.textContent = field.title || key;
        group.appendChild(title);
        let nested = document.createElement("div");
        nested.className = "settings-form";
        group.appendChild(nested);
        host.appendChild(group);
        this.appendSchemaFields(nested, field, settings, path);
        continue;
      }
      let row = document.createElement("div");
      row.className = "setting-row";
      let label = document.createElement("label");
      label.className = "setting-label";
      label.textContent = field.title || key;
      row.appendChild(label);
      let control = document.createElement("div");
      row.appendChild(control);
      let input;
      if (field.enum) {
        control.className = "choice-group";
        let groupName = "setting-" + this.selectedStep + "-" + path.join("-");
        field.enum.forEach((choice, index) => {
          let choiceLabel = document.createElement("label");
          choiceLabel.className = "choice" + (value === choice ? " checked" : "");
          let radio = document.createElement("input");
          radio.type = "radio";
          radio.name = groupName;
          radio.checked = value === choice;
          let text = document.createElement("span");
          text.textContent = field.enumNames && field.enumNames[index] || choice;
          choiceLabel.appendChild(radio);
          choiceLabel.appendChild(text);
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            this.setPath(settings, path, choice);
            for (let item of control.children) item.classList.remove("checked");
            choiceLabel.classList.add("checked");
            this.updatePublishPreviewIfNeeded();
          });
          control.appendChild(choiceLabel);
        });
      } else if (field.type === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!value;
        let toggle = document.createElement("label");
        toggle.className = "toggle";
        let toggleText = document.createElement("span");
        toggleText.textContent = input.checked ? "Enabled" : "Disabled";
        toggle.appendChild(input);
        toggle.appendChild(toggleText);
        control.appendChild(toggle);
        input.addEventListener("change", () => {
          this.setPath(settings, path, input.checked);
          toggleText.textContent = input.checked ? "Enabled" : "Disabled";
          this.updatePublishPreviewIfNeeded();
        });
      } else if (field.type === "integer" || field.type === "number") {
        input = document.createElement("input");
        input.type = "number";
        if (field.minimum !== undefined) input.min = field.minimum;
        input.value = value === undefined ? "" : value;
      } else if (field.type === "array") {
        input = document.createElement("input");
        input.type = "text";
        input.value = Array.isArray(value) ? value.join(", ") : "";
        input.dataset.valueType = "array";
      } else if (field.type === "object") {
        input = document.createElement("textarea");
        input.value = Object.entries(value || {}).map(([itemKey, itemValue]) => itemKey + ": " + itemValue).join("\n");
        input.dataset.valueType = "object";
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = value === undefined ? "" : value;
      }
      if (input && field.type !== "boolean") {
        control.appendChild(input);
        let update = () => {
          let next;
          if (field.type === "integer") next = parseInt(input.value, 10) || 0;
          else if (field.type === "number") next = parseFloat(input.value) || 0;
          else if (input.dataset.valueType === "array") next = input.value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
          else if (input.dataset.valueType === "object") next = this.parseKeyValues(input.value);
          else next = input.value;
          this.setPath(settings, path, next);
          this.updatePublishPreviewIfNeeded();
        };
        input.addEventListener("input", update);
        input.addEventListener("change", update);
      }
      if (field.description) {
        let help = document.createElement("div");
        help.className = "setting-help";
        help.textContent = field.description;
        row.appendChild(help);
      }
      host.appendChild(row);
    }
  },

  appendPublishPreview(host, step) {
    let preview = document.createElement("div");
    preview.id = "publish-path-preview";
    preview.className = "resolved-path";
    host.appendChild(preview);
    this.updatePublishPreview(step);
  },

  updatePublishPreviewIfNeeded() {
    let step = this.current && this.current.modules[this.selectedStep];
    if (step && step.module === "publish.markdown-directory") this.updatePublishPreview(step);
  },

  updatePublishPreview(step) {
    let preview = document.getElementById("publish-path-preview");
    if (!preview) return;
    let destination = String((step.settings || {}).destination || "").trim();
    let root = document.getElementById("s-output-root").value.trim();
    let absolute = /^[A-Za-z]:[\\/]/.test(destination) || /^[/\\]{2}/.test(destination) || destination.startsWith("/");
    if (destination.startsWith("obsidian://")) {
      let spec = destination.slice("obsidian://".length).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      let slash = spec.indexOf("/");
      let vault = slash < 0 ? spec : spec.slice(0, slash);
      let sub = slash < 0 ? "" : spec.slice(slash + 1);
      preview.textContent = vault
        ? 'Actual output directory: Obsidian vault "' + vault + '"' + (sub ? " / " + sub : "")
          + " (located from the local Obsidian configuration on save; works on Windows and macOS)"
        : "The obsidian:// destination has no vault name; the format is obsidian://<vault>/<subdirectory>";
    } else if (absolute) {
      preview.textContent = "Actual output directory: " + destination + " (absolute path; the default output base directory is not used)";
    } else if (root && destination) {
      let separator = root.includes("\\") ? "\\" : "/";
      preview.textContent = "Actual output directory: " + root.replace(/[\\/]+$/, "") + separator + destination.replace(/^[\\/]+/, "");
    } else if (!destination) {
      preview.textContent = "Enter a Publish destination directory.";
    } else {
      preview.textContent = "This is a relative directory; set a default output base directory under Settings → Service directories, or use an absolute path here.";
    }
  },

  parseKeyValues(text) {
    let result = {};
    for (let line of text.split(/\r?\n/)) {
      let match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
      if (match) result[match[1].trim()] = match[2].trim();
    }
    return result;
  },

  async saveTemplate() {
    if (!this.online || !this.current) return;
    try {
      this.current.name = document.getElementById("template-name").value.trim();
      this.current.description = document.getElementById("template-description").value.trim();
      let response = await api.client.saveTemplate(this.current.id, { template: this.current });
      this.currentDocument = response;
      this.current = this.clone(response.template);
      await this.loadTemplateCatalog(this.current.id);
      document.getElementById("template-validation").textContent = "Template structure is valid";
      this.flash("template-saved");
    } catch (error) {
      document.getElementById("template-validation").textContent = "Save failed: " + error;
      window.alert("Failed to save the template: " + error);
    }
  },

  async reloadTemplate() {
    if (this.current) await this.loadTemplate(this.current.id);
  },

  async duplicateTemplate() {
    if (!this.current) return;
    let id = window.prompt("New template ID (lowercase letters, digits, and hyphens)", this.current.id + "-copy");
    if (!id) return;
    id = id.trim();
    let duplicate = this.clone(this.current);
    duplicate.id = id;
    duplicate.name = duplicate.name + " copy";
    duplicate.version = 1;
    try {
      await api.client.saveTemplate(id, { template: duplicate });
      await this.loadTemplateCatalog(id);
    } catch (error) { window.alert("Duplicate failed: " + error); }
  },

  async resetTemplate() {
    if (!this.current) return;
    let action = this.currentDocument && this.currentDocument.builtin ? "Restore the built-in defaults" : "Delete this user template";
    if (!window.confirm(action + "?")) return;
    try {
      let id = this.current.id;
      await api.client.resetTemplate(id);
      this.current = null;
      this.currentDocument = null;
      await this.loadTemplateCatalog(id);
    } catch (error) { window.alert("Action failed: " + error); }
  },

  async applyYaml() {
    if (!this.current) return;
    try {
      let response = await api.client.saveTemplate(this.current.id, {
        yaml: document.getElementById("template-yaml").value,
      });
      this.currentDocument = response;
      this.current = this.clone(response.template);
      await this.loadTemplateCatalog(this.current.id);
      this.flash("template-saved");
    } catch (error) { window.alert("Invalid YAML: " + error); }
  },

  flash(id) {
    let element = document.getElementById(id);
    element.classList.add("show");
    setTimeout(() => element.classList.remove("show"), 2000);
  },
};

window.addEventListener("DOMContentLoaded", () => Panel.init());
