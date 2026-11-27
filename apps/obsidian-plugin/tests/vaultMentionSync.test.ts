import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkIndex, type SourceDocument } from "../src/linkIndex";
import type { UnizeroBridge, VaultMentionSnapshot } from "../src/bridge";
import { BRIDGE_API } from "../src/bridge";
import { snapshotReady, vaultMentionEntries, VaultMentionSync } from "../src/vaultMentionSync";

const pdf = "zotero://open-pdf/library/items/PDFA0001?page=3&annotation=ANNO0001";
const vault = (path: string, format: "md" | "canvas" = "md"): SourceDocument =>
  ({ kind: "vault", path, title: path.replace(/\.\w+$/, ""), vaultID: "v", format });
const zotero: SourceDocument = { kind: "zotero", libraryID: 1, itemKey: "AKEY0001", attachmentKey: "RAW00001",
  title: "Raw", itemTitle: "A", format: "md", purpose: "raw", version: "1" };
const canvas = (...texts: string[]) => JSON.stringify({ nodes: texts.map((text, i) => ({ id: `n${i}`, type: "text", text })), edges: [] });

function index(): LinkIndex {
  const links = new LinkIndex();
  links.replace(vault("Notes/Review.md"), [
    `Cox finds a reversal [C](unizero://paper/1/CKEY0001) and [again](unizero://paper/1/CKEY0001.pdf) [pdf](${pdf}).`,
    "",
    "Hidden [B](unizero://paper/1/BKEY0001 \"nocite\") and a note [n](unizero://note/v/uid).",
    "",
    "- Ball [B](unizero://paper/1/BKEY0001)",
  ].join("\n"));
  links.replace(vault("Literature.canvas", "canvas"), canvas("[B](unizero://paper/1/BKEY0001)", "[B](unizero://paper/1/BKEY0001)"));
  links.replace(zotero, "[B](unizero://paper/1/BKEY0001)");
  return links;
}

describe("Vault mention snapshot", () => {
  it("lists paper links in Vault notes only, one per unit and paper, without nocite links", () => {
    const entries = vaultMentionEntries(index().records.values(), (path) => path === "Notes/Review.md" ? 42 : undefined);
    expect(entries.map((entry) => [entry.path, entry.nodeId, entry.line, entry.itemKey])).toEqual([
      ["Literature.canvas", "n0", 0, "BKEY0001"],
      ["Literature.canvas", "n1", 0, "BKEY0001"],
      ["Notes/Review.md", undefined, 0, "CKEY0001"],
      ["Notes/Review.md", undefined, 4, "BKEY0001"],
    ]);
    expect(entries[2]).toMatchObject({ title: "Notes/Review", format: "md", text: "Cox finds a reversal C and again .", pdf: [pdf], time: 42 });
    expect(entries[0]).not.toHaveProperty("time");
  });

  it("is sent only once the Vault index has finished a pass", () => {
    expect(["unbuilt", "updating", "complete", "partial"].map((state) => snapshotReady(state as never))).toEqual([false, false, true, true]);
  });
});

describe("Vault mention sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(capabilities = ["vault-mentions"]) {
    const links = index();
    const sent: VaultMentionSnapshot[] = [];
    let vaultID = "vault-1", enabled = true, vaultName = "Notes";
    const bridge = {
      ping: vi.fn(async () => ({ product: "unizero", addonVersion: "x", api: BRIDGE_API, capabilities, ready: true })),
      vaultMentions: vi.fn(async (snapshot: VaultMentionSnapshot) => { sent.push(snapshot); return { vaultID: snapshot.vaultID, mentions: snapshot.mentions.length }; }),
    } as unknown as UnizeroBridge;
    const sync = new VaultMentionSync({
      bridge, endpoint: () => "http://127.0.0.1:23119", enabled: () => enabled,
      vaultID: () => vaultID, vaultName: () => vaultName, vaultState: () => links.vaultState,
      records: () => links.records.values(), mtime: () => undefined, subscribe: (listener) => links.subscribe(listener),
    });
    return { links, sent, sync, bridge, setVault: (id: string) => { vaultID = id; },
      setEnabled: (value: boolean) => { enabled = value; }, setName: (name: string) => { vaultName = name; } };
  }

  it("waits for a finished pass, sends once, and resends only what changed", async () => {
    const { links, sent, sync } = setup();
    sync.start();
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveLength(0);
    links.vaultState = "complete";
    links.notify();
    await vi.runOnlyPendingTimersAsync();
    expect(sent.map((each) => [each.vaultID, each.vaultName, each.mentions.length])).toEqual([["vault-1", "Notes", 4]]);
    links.notify();
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveLength(1);
    links.replace(vault("New.md"), "[D](unizero://paper/1/DKEY0001)");
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveLength(2);
    expect(sent[1].mentions.map((each) => each.itemKey)).toContain("DKEY0001");
    sync.stop();
  });

  it("clears the old Vault's snapshot when the Vault gets a new identity", async () => {
    const { links, sent, sync, setVault } = setup();
    links.vaultState = "complete";
    sync.start();
    await vi.runOnlyPendingTimersAsync();
    setVault("vault-2");
    sync.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(sent.map((each) => [each.vaultID, each.mentions.length])).toEqual([["vault-1", 4], ["vault-1", 0], ["vault-2", 4]]);
    sync.stop();
  });

  it("clears Zotero's snapshot when sharing is turned off, once", async () => {
    const { links, sent, sync, setEnabled } = setup();
    links.vaultState = "complete";
    sync.start();
    await vi.runOnlyPendingTimersAsync();
    setEnabled(false);
    sync.schedule();
    await vi.runOnlyPendingTimersAsync();
    links.replace(vault("New.md"), "[D](unizero://paper/1/DKEY0001)");
    await vi.runOnlyPendingTimersAsync();
    expect(sent.map((each) => [each.vaultID, each.mentions.length])).toEqual([["vault-1", 4], ["vault-1", 0]]);
    sync.stop();
  });

  it("resends when only the Vault's name changed", async () => {
    const { links, sent, sync, setName } = setup();
    links.vaultState = "complete";
    sync.start();
    await vi.runOnlyPendingTimersAsync();
    setName("Renamed");
    sync.schedule();
    await vi.runOnlyPendingTimersAsync();
    expect(sent.map((each) => each.vaultName)).toEqual(["Notes", "Renamed"]);
    sync.stop();
  });

  it("does not send to an add-on without the endpoint", async () => {
    const { links, sync, bridge } = setup([]);
    links.vaultState = "complete";
    sync.start();
    await vi.runOnlyPendingTimersAsync();
    expect(bridge.vaultMentions).not.toHaveBeenCalled();
    sync.stop();
  });
});
