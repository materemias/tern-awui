// The server's side of CodexBar AgentView's waits: finds `codexbar_waiting.py`, keeps the view it
// reports, refreshed when the CLI rewrites waiting_view.json, and runs the phone's actions. The CLI
// is the only writer of its state and holds every rule; lib/waiting-view.ts reads what it prints.
import { statSync, watch, existsSync, readFileSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { obj, str, type Obj } from "./json";
import { newlyOnMe, parseView, waitingArgs, type OnMe, type Waiting, type WaitingAction, type WaitingView } from "./waiting-view";

type Env = Record<string, string | undefined>;

/** Writes arriving within this window share one `list`. */
const BATCH_MS = 150;
/** A `list` that failed is retried this long after, unless the CLI writes its file sooner. */
const RETRY_MS = 60_000;
/**
 * The CLI's tick moves `health.checkedAt` about every minute; the app needs it only to tell a tick
 * older than 15 minutes apart, so a move within this step is no change to send.
 */
const HEALTH_STEP_MS = 5 * 60_000;

/**
 * `$CODEXBAR_WAITING`, else the script beside the Tern plugin of a CodexBar AgentView checkout
 * (`~/.config/tern/plugins/codexbar-agentview.path` holds `<checkout>/tern`). Null without either:
 * the feature is off.
 */
export function locateWaitingCli(env: Env, home: string): string | null {
  if (env.CODEXBAR_WAITING) return existsSync(env.CODEXBAR_WAITING) ? resolve(env.CODEXBAR_WAITING) : null;
  try {
    const plugin = readFileSync(join(home, ".config", "tern", "plugins", "codexbar-agentview.path"), "utf8").trim();
    if (!isAbsolute(plugin)) return null;
    const cli = resolve(plugin, "..", "contents", "scripts", "codexbar_waiting.py");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** The file the CLI rewrites on every change, in its own state folder (state_paths.py). */
export function waitingViewFile(env: Env, home: string): string {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(state, "codexbar-agentview", "waiting_view.json");
}

/** The file's identity and size; "" when it is missing or can't be looked at (a folder it can't enter). */
function stamp(path: string): string {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    return st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "";
  } catch {
    return "";
  }
}

/** The CLI's one JSON object; empty when it printed something else or nothing. */
function answer(out: string | null): Obj {
  try {
    return obj(JSON.parse(out ?? ""));
  } catch {
    return {};
  }
}

export type WaitingOptions = {
  env: Env;
  home: string;
  /** Runs the script with these arguments: its stdout, or null when it didn't run or was killed. */
  run(argv: string[]): Promise<string | null>;
  /** What the app shows changed. */
  changed(): void;
  /** These rows newly wait on the user. */
  onMe(fresh: OnMe[]): void;
  /** How long after a failed `list` a check retries it; `RETRY_MS` by default. */
  retryMs?: number;
};

export class WaitingWatch {
  /** The current view, once `view()` has resolved: read it with `key` in one go. */
  held: Waiting = { available: false };
  /** Compares two views for a stream: changes when `held` shows something else (a tick's clock only in steps, see `HEALTH_STEP_MS`). */
  key = JSON.stringify(this.held);
  private readonly file: string;
  private cli: string | null = null;
  /** The waits on the user at the last look; null before the first. */
  private known: Set<string> | null = null;
  private watcher: FSWatcher | null = null;
  private batch: Timer | null = null;
  /** The file as the running or last read saw it. */
  private seen = "";
  private running: Promise<void> | null = null;
  /** The state moved during a read: its result is old, so it reads again. */
  private again = false;
  private stopped = false;
  /** When the last `list` failed. */
  private failedAt = 0;

  constructor(private readonly options: WaitingOptions) {
    this.file = waitingViewFile(options.env, options.home);
    void this.check();
  }

  /**
   * Finds the CLI and rereads a view that changed unseen. Called now and then: the file watcher is
   * the fast path, this catches a checkout installed later, a state folder that didn't exist yet
   * and, while `watched` (someone is looking), a `list` that failed, at most every `retryMs`.
   */
  async check(watched = true): Promise<void> {
    if (this.stopped) return;
    this.cli = locateWaitingCli(this.options.env, this.options.home);
    if (!this.cli) {
      this.known = null;
      return this.hold({ available: false });
    }
    this.follow();
    const retry = this.held.available && this.held.error && watched && Date.now() - this.failedAt >= (this.options.retryMs ?? RETRY_MS);
    if (!this.held.available || retry || stamp(this.file) !== this.seen) await this.refresh();
  }

  /** The current view; the first call waits for the first read. */
  async view(): Promise<Waiting> {
    if (!this.held.available && this.running) await this.running;
    return this.held;
  }

  /** Runs one of the phone's actions; ids are checked against the current view first. */
  async act(action: WaitingAction, body: Obj): Promise<{ status: number; body: Obj }> {
    const view = await this.view();
    if (!view.available || !this.cli) return { status: 409, body: { error: "CodexBar AgentView isn't installed" } };
    const argv = waitingArgs(action, body, view.rows);
    if (!Array.isArray(argv)) return { status: argv.status, body: { error: argv.error } };
    const reply = answer(await this.options.run([this.cli, ...argv]));
    if (reply.ok !== true) return { status: 502, body: { error: str(reply.error, "codexbar_waiting.py gave no answer") } };
    const next = parseView(reply.view);
    if (!next) void this.refresh();
    else if (!this.stopped) {
      if (this.running) this.again = true;
      this.take(next);
    }
    return { status: 200, body: { ok: true } };
  }

  stop() {
    this.stopped = true;
    this.watcher?.close();
    clearTimeout(this.batch ?? undefined);
  }

  /** Watches the folder, as the CLI replaces the file by renaming; a missing folder waits for the next check. */
  private follow() {
    if (this.watcher) return;
    const name = basename(this.file);
    try {
      this.watcher = watch(dirname(this.file), (_event, file) => {
        if (file !== name || this.batch || this.stopped) return;
        this.batch = setTimeout(() => {
          this.batch = null;
          void this.refresh();
        }, BATCH_MS);
      });
      this.watcher.on("error", () => {});
    } catch {}
  }

  /** One read at a time; a call during one runs another right after it. */
  private refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const cli = this.cli;
          if (!cli || this.stopped) return;
          const view = await this.read(cli);
          // The CLI went away or the server stopped meanwhile: this read says nothing any more.
          if (!this.cli || this.stopped) return;
          if (!this.again) this.take(view);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * The view as it is now. The file holds `list`'s own output and the CLI rewrites it on every
   * tick, so a changed file spares starting Python. Anything else runs `list`: the first look
   * (with no tick running the file can be old) and a file that doesn't read as a view.
   */
  private async read(cli: string): Promise<WaitingView | null> {
    const before = this.seen;
    this.seen = stamp(this.file);
    const written = before && this.seen !== before ? parseView(answer(await readFile(this.file, "utf8").catch(() => null))) : null;
    return written ?? parseView(answer(await this.options.run([cli, "list"])));
  }

  private take(view: WaitingView | null) {
    if (!view) {
      this.failedAt = Date.now();
      // The last health stays: without it a close would look safe while nothing checks the waits.
      const last = this.held.available ? { onMe: this.held.onMe, rows: this.held.rows, ...(this.held.health && { health: this.held.health }) } : { onMe: 0, rows: [] };
      return this.hold({ available: true, ...last, error: "codexbar_waiting.py list gave no answer" });
    }
    const { keys, fresh } = newlyOnMe(view.rows, this.known);
    this.known = keys;
    this.hold({ available: true, ...view });
    if (fresh.length) this.options.onMe(fresh);
  }

  private hold(next: Waiting) {
    this.held = next;
    const health = next.available ? next.health : undefined;
    const key = JSON.stringify(health ? { ...next, health: { ...health, checkedAt: Math.floor(health.checkedAt / HEALTH_STEP_MS) } } : next);
    if (key === this.key) return;
    this.key = key;
    this.options.changed();
  }
}
