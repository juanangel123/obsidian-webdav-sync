import {
  type App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
  normalizePath,
  requestUrl,
} from "obsidian";
import { type Keys, DecryptError, buf } from "./crypto";
import type { Deletions, LocalFile } from "./plan";
import { type LocalFs, type Result, type State, LocalChanged, NoVault, openVault, sync } from "./sync";
import { type Http, WebDav, WebDavError } from "./webdav";

/** A run starts this long after the last edit (when "Sync after editing" is on). */
const AFTER_EDIT_MS = 20_000;
/** The first run after Obsidian opens (when "Sync on startup" is on). */
const STARTUP_MS = 3_000;
/** A request gives up after this long, plus a second per 50 kB it sends. */
const TIMEOUT_MS = 60_000;

interface Settings {
  url: string;
  username: string;
  intervalMinutes: number; // 0 = off
  syncOnStartup: boolean;
  syncAfterEdit: boolean;
  maxFileMB: number;
}

const DEFAULTS: Settings = {
  url: "",
  username: "",
  intervalMinutes: 5,
  syncOnStartup: true,
  syncAfterEdit: true,
  maxFileMB: 50,
};

interface Data {
  settings: Settings;
  /** Random per vault: the ids of its secrets in Obsidian's secret storage. */
  secretsId: string;
  /** The server vault the state belongs to; another one means a fresh state. */
  vault?: { url: string; username: string; id: string };
  state: State;
  lastSync?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    p.finally(() => window.clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

const http: Http = async (req) => {
  const size = typeof req.body === "string" ? req.body.length : (req.body?.byteLength ?? 0);
  const res = await withTimeout(
    requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false }),
    TIMEOUT_MS + size / 50,
    req.method,
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, body: res.arrayBuffer };
};

class VaultFs implements LocalFs {
  constructor(
    private readonly app: App,
    private readonly wrote: (path: string) => void,
  ) {}

  async list(): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>();
    for (const f of this.app.vault.getFiles()) out.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });
    return out;
  }

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private same(f: TFile | null, expected: LocalFile | null): boolean {
    if (!expected) return !f;
    return !!f && f.stat.mtime === expected.mtime && f.stat.size === expected.size;
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.file(path);
    if (!f) throw new LocalChanged("not found locally");
    return new Uint8Array(await this.app.vault.readBinary(f));
  }

  async write(path: string, data: Uint8Array, expected: LocalFile | null): Promise<LocalFile> {
    if (normalizePath(path) !== path) throw new Error("a name this device can't hold as is");
    const existing = this.file(path);
    if (!this.same(existing, expected)) throw new LocalChanged();
    if (!existing && (await this.app.vault.adapter.exists(path))) throw new LocalChanged(); // there, but not indexed
    this.wrote(path);
    let f: TFile;
    if (existing) {
      await this.app.vault.modifyBinary(existing, buf(data));
      f = existing;
    } else {
      const parts = path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
      }
      f = await this.app.vault.createBinary(path, buf(data));
    }
    return { mtime: f.stat.mtime, size: f.stat.size };
  }

  async trash(path: string, expected: LocalFile): Promise<void> {
    const f = this.file(path);
    if (!this.same(f, expected)) throw new LocalChanged();
    this.wrote(path);
    await this.app.vault.trash(f!, false);
  }
}

export default class WebDavSyncPlugin extends Plugin {
  data: Data = { settings: { ...DEFAULTS }, secretsId: "", state: {} };
  private keys: { for: string; keys: Keys; id: string } | null = null;
  private running = false;
  private again: { manual: boolean; confirmed?: Deletions } | null = null;
  private unloaded = false;
  /** Automatic runs stop after an error a retry can't fix (wrong password or passphrase), until the settings change. */
  private paused: string | null = null;
  private lastErrors = "";
  private statusBar: HTMLElement | null = null;
  private timer: number | null = null;
  private startup: number | null = null;
  private readonly ownWrites = new Map<string, number>(); // path → when this plugin wrote it
  private readonly syncSoon = debounce(() => void this.runSync(false), AFTER_EDIT_MS, true);

  async onload(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<Data> & { settings?: Record<string, unknown> };
    this.data = {
      settings: { ...DEFAULTS, ...(saved.settings as Partial<Settings>) },
      secretsId: saved.secretsId || Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join(""),
      vault: saved.vault,
      state: saved.state ?? {},
      lastSync: saved.lastSync,
    };
    // Secrets given in data.json (an older version, or a scripted setup) move to the secret storage.
    for (const key of ["password", "passphrase"] as const) {
      const v = saved.settings?.[key];
      if (typeof v === "string" && v) this.setSecret(key, v);
      delete (this.data.settings as unknown as Record<string, unknown>)[key];
    }
    await this.save();

    this.addRibbonIcon("refresh-cw", "Sync with WebDAV", () => void this.runSync(true));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync(true) });
    this.addCommand({
      id: "forget-state",
      name: "Forget sync state (the next sync compares every file and deletes nothing)",
      callback: async () => {
        this.data.state = {};
        await this.save();
        new Notice("WebDAV Sync: state forgotten. The next sync compares every file.");
      },
    });
    if (!Platform.isMobile) this.statusBar = this.addStatusBarItem();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.schedule();

    this.app.workspace.onLayoutReady(() => {
      // Registered here: the vault fires "create" for every file while it loads.
      const changed = (file: { path: string }) => {
        const own = this.ownWrites.get(file.path);
        if (own && Date.now() - own < 5_000) return; // the plugin's own write
        if (!this.data.settings.syncAfterEdit) return;
        if (this.running) this.again ??= { manual: false };
        else this.syncSoon();
      };
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      if (this.data.settings.syncOnStartup) this.startup = window.setTimeout(() => void this.runSync(false), STARTUP_MS);
    });
    this.showStatus();
  }

  onunload(): void {
    this.unloaded = true;
    this.syncSoon.cancel();
    if (this.startup !== null) window.clearTimeout(this.startup);
  }

  schedule(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const min = this.data.settings.intervalMinutes;
    if (min > 0) this.timer = this.registerInterval(window.setInterval(() => void this.runSync(false), min * 60_000));
  }

  async save(): Promise<void> {
    await this.saveData(this.data);
  }

  private secretKey(key: "password" | "passphrase"): string {
    return `webdav-vault-sync-${this.data.secretsId}-${key}`;
  }

  getSecret(key: "password" | "passphrase"): string {
    return this.app.secretStorage.getSecret(this.secretKey(key)) ?? "";
  }

  setSecret(key: "password" | "passphrase", value: string): void {
    this.app.secretStorage.setSecret(this.secretKey(key), value);
  }

  /** After the settings change: cached keys dropped, automatic runs allowed again. */
  settingsChanged(): void {
    this.keys = null;
    this.paused = null;
    this.lastErrors = "";
    this.showStatus();
  }

  configured(): boolean {
    const s = this.data.settings;
    return !!(s.url && s.username && this.getSecret("password") && this.getSecret("passphrase"));
  }

  /** The server address, or an error message when it is not one this plugin will send a password to. */
  serverProblem(): string | null {
    let u: URL;
    try {
      u = new URL(this.data.settings.url);
    } catch {
      return "the server address is not a URL";
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "the server address must start with https://";
    return null;
  }

  dav(): WebDav {
    const s = this.data.settings;
    return new WebDav(http, s.url, s.username, this.getSecret("password"));
  }

  async unlock(dav: WebDav, create: boolean): Promise<{ keys: Keys; id: string }> {
    const s = this.data.settings;
    const passphrase = this.getSecret("passphrase");
    const id = `${s.url}\n${s.username}\n${passphrase}`;
    if (this.keys?.for === id) return this.keys;
    const v = await openVault(dav, passphrase, { create });
    this.keys = { for: id, ...v };
    return v;
  }

  private showStatus(text?: string): void {
    if (!this.statusBar) return;
    if (text) return void this.statusBar.setText(text);
    if (this.paused) return void this.statusBar.setText(`Sync paused: ${this.paused}`);
    const t = this.data.lastSync;
    this.statusBar.setText(t ? `Synced ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "");
  }

  async runSync(manual: boolean, confirmed?: Deletions): Promise<void> {
    if (this.unloaded) return;
    if (!this.configured()) {
      if (manual) new Notice("WebDAV Sync: fill in the settings first.");
      return;
    }
    const problem = this.serverProblem();
    if (problem) {
      if (manual) new Notice(`WebDAV Sync: ${problem}.`);
      return;
    }
    if (!manual && this.paused) return;
    if (this.running) {
      if (manual) {
        new Notice("WebDAV Sync: already syncing; another run follows.");
        this.again = { manual: true, confirmed };
      }
      return;
    }
    this.running = true;
    this.showStatus("Syncing…");
    try {
      const dav = this.dav();
      const vault = await this.unlock(dav, manual);
      const s = this.data.settings;
      const here = { url: s.url, username: s.username, id: vault.id };
      if (JSON.stringify(this.data.vault) !== JSON.stringify(here)) {
        // Another server or another vault on it: the old state means nothing there (and would delete everything).
        this.data.vault = here;
        this.data.state = {};
      }
      const result = await sync({
        dav,
        keys: vault.keys,
        local: new VaultFs(this.app, (p) => this.ownWrites.set(p, Date.now())),
        state: this.data.state,
        confirmed,
        maxBytes: s.maxFileMB * 1024 * 1024,
        onProgress: async (state) => {
          this.data.state = state;
          await this.save();
        },
        log: (m) => console.warn(`[webdav-sync] ${m}`),
      });
      if (result.blocked) return this.blocked(result.blocked, manual);
      this.data.state = result.state;
      this.data.lastSync = Date.now();
      this.paused = null;
      await this.save();
      this.report(result, manual);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fatal = err instanceof DecryptError || err instanceof NoVault || (err instanceof WebDavError && [401, 403].includes(err.status));
      if (fatal) {
        this.keys = null;
        this.paused = msg;
      }
      if (manual || (fatal && this.lastErrors !== msg)) new Notice(`WebDAV Sync: ${msg}`, 10_000);
      this.lastErrors = msg;
      console.error("[webdav-sync]", err);
      this.showStatus(fatal ? undefined : `Sync failed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      return;
    } finally {
      this.running = false;
      const next = this.again;
      this.again = null;
      if (next && !this.unloaded) {
        if (next.manual) void this.runSync(true, next.confirmed);
        else this.syncSoon();
      }
    }
    this.showStatus();
  }

  private blocked(d: Deletions, manual: boolean): void {
    const n = d.local.length + d.remote.length;
    if (!manual) {
      this.paused = `${n} deletions to confirm (Sync now)`;
      this.showStatus();
      if (this.lastErrors !== this.paused) new Notice(`WebDAV Sync: paused, a sync would delete ${n} files. Press Sync now to review.`, 15_000);
      this.lastErrors = this.paused;
      return;
    }
    new ConfirmModal(this.app, d, () => {
      this.paused = null;
      void this.runSync(true, d);
    }).open();
  }

  private report(r: Result, manual: boolean): void {
    const parts: string[] = [];
    if (r.uploaded) parts.push(`${r.uploaded} up`);
    if (r.downloaded) parts.push(`${r.downloaded} down`);
    if (r.deletedLocal) parts.push(`${r.deletedLocal} moved to this vault's trash`);
    if (r.deletedRemote) parts.push(`${r.deletedRemote} deleted on the server`);
    if (r.conflicts.length) new Notice(`WebDAV Sync: conflict, kept both:\n${r.conflicts.join("\n")}`, 15_000);
    const errors = r.errors.join("\n");
    if (errors && (manual || errors !== this.lastErrors))
      new Notice(`WebDAV Sync: ${r.errors.length} failed:\n${r.errors.slice(0, 5).join("\n")}`, 15_000);
    this.lastErrors = errors;
    if (manual && r.skipped.length) new Notice(`WebDAV Sync: left out (too big, or a name the server can't take):\n${r.skipped.slice(0, 5).join("\n")}`, 10_000);
    if (manual && !errors) new Notice(`WebDAV Sync: ${parts.length ? parts.join(", ") : "up to date"}`);
    else if (!manual && r.deletedLocal) new Notice(`WebDAV Sync: ${r.deletedLocal} deleted on another device, moved to this vault's trash`);
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly d: Deletions,
    private readonly onYes: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "WebDAV Sync: many deletions" });
    const list = (title: string, paths: string[]) => {
      if (!paths.length) return;
      contentEl.createEl("p", { text: `${title} (${paths.length}):` });
      const ul = contentEl.createEl("ul");
      for (const p of paths.slice(0, 10)) ul.createEl("li", { text: p });
      if (paths.length > 10) ul.createEl("li", { text: `…and ${paths.length - 10} more` });
    };
    list("To move to this vault's trash, deleted on the server or another device", this.d.local);
    list("To delete on the server, deleted on this device", this.d.remote);
    contentEl.createEl("p", { text: "If this is not what you expect (a wrong server, a wiped folder), cancel. Automatic syncing stays paused until you sync by hand." });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Delete and sync")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onYes();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: WebDavSyncPlugin,
  ) {
    super(app, plugin);
  }

  /** A text field saved when it loses focus (not on every key: a half-typed passphrase must never be used). */
  private field(name: string, desc: string, value: string, save: (v: string) => void, secret = false): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        if (secret) t.inputEl.type = "password";
        t.setValue(value);
        t.inputEl.addEventListener("change", async () => {
          save(t.getValue().trim());
          this.plugin.settingsChanged();
          await this.plugin.save();
        });
      });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.data.settings;
    const p = this.plugin;

    this.field("Server", "The WebDAV folder for this vault, https://… — an empty folder, one per vault.", s.url, (v) => (s.url = v));
    this.field("Username", "", s.username, (v) => (s.username = v));
    this.field("Password", "Kept in Obsidian's secret storage, not in the vault.", p.getSecret("password"), (v) => p.setSecret("password", v), true);
    this.field(
      "Encryption passphrase",
      "Encrypts every note and its name before it leaves this device; the same on every device. The first device's first sync sets it. Without it the notes on the server can't be read: keep it safe.",
      p.getSecret("passphrase"),
      (v) => p.setSecret("passphrase", v),
      true,
    );
    const number = (name: string, desc: string, value: number, ok: (n: number) => boolean, save: (n: number) => void) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.setValue(String(value));
          t.inputEl.addEventListener("change", async () => {
            const n = Number(t.getValue());
            if (!ok(n)) return void t.setValue(String(value));
            save(n);
            await p.save();
            p.schedule();
          });
        });
    number("Sync every (minutes)", "0 turns it off.", s.intervalMinutes, (n) => Number.isInteger(n) && n >= 0, (n) => (s.intervalMinutes = n));
    number("Largest file (MB)", "Bigger files are left out of the sync.", s.maxFileMB, (n) => Number.isFinite(n) && n >= 1, (n) => (s.maxFileMB = n));
    new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await p.save();
      }),
    );
    new Setting(containerEl)
      .setName("Sync after editing")
      .setDesc(`${AFTER_EDIT_MS / 1000} seconds after the last change.`)
      .addToggle((t) =>
        t.setValue(s.syncAfterEdit).onChange(async (v) => {
          s.syncAfterEdit = v;
          await p.save();
        }),
      );
    new Setting(containerEl)
      .setName("Check connection")
      .setDesc("Logs in and checks the passphrase. On a server with no vault yet, sets it up with this passphrase.")
      .addButton((b) =>
        b.setButtonText("Check").onClick(async () => {
          if (!p.configured()) return void new Notice("Fill in the four fields first.");
          const problem = p.serverProblem();
          if (problem) return void new Notice(`WebDAV Sync: ${problem}.`);
          try {
            p.settingsChanged();
            await p.unlock(p.dav(), true);
            new Notice("WebDAV Sync: connected, passphrase right.");
          } catch (err) {
            new Notice(`WebDAV Sync: ${err instanceof Error ? err.message : err}`, 10_000);
          }
        }),
      );
    new Setting(containerEl).setName("Sync now").addButton((b) => b.setButtonText("Sync").setCta().onClick(() => void p.runSync(true)));
  }
}
