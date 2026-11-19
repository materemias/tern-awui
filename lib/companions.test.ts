import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { companions } from "./companions";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "tern-awui-companions-"));
  homes.push(h);
  return h;
}
function put(path: string, text = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
/** Which ids are installed, in the answer's order. */
const installed = async (env: Record<string, string | undefined>, h: string) =>
  (await companions(env, h)).filter((c) => c.installed).map((c) => c.id);

describe("companions", () => {
  test("nothing installed: every companion, not found, in the About window's order", async () => {
    expect(await companions({}, home())).toEqual([
      { id: "omp-stretch", installed: false },
      { id: "codexbar-agentview", installed: false },
      { id: "omp-compact", installed: false },
    ]);
  });

  test("marketplace plugins count by their key in installed_plugins.json, with an install listed", async () => {
    const h = home();
    put(join(h, ".omp", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "omp-compact@arksdev": [{ scope: "user" }], "omp-stretch@omp-stretch": [] } }));
    expect(await installed({}, h)).toEqual(["omp-compact"]);
  });

  test("plugin packages count by their folder in node_modules, under $XDG_DATA_HOME/omp too", async () => {
    const h = home();
    mkdirSync(join(h, ".omp", "plugins", "node_modules", "omp-stretch"), { recursive: true });
    mkdirSync(join(h, "data", "omp", "plugins", "node_modules", "omp-compact"), { recursive: true });
    expect(await installed({}, h)).toEqual(["omp-stretch"]);
    expect(await installed({ XDG_DATA_HOME: join(h, "data") }, h)).toEqual(["omp-stretch", "omp-compact"]);
  });

  test("extension paths count from settings.json or config.yml, in $PI_CODING_AGENT_DIR when set", async () => {
    const h = home();
    put(join(h, "Sync", "code", "omp-stretch", "stretch.ts"));
    put(join(h, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: ["~/Sync/code/omp-stretch/stretch.ts", "~/x/other.ts"] }));
    expect(await installed({}, h)).toEqual(["omp-stretch"]);
    // A folder entry counts, and a relative path is taken from the agent folder.
    const agent = join(h, "agent-elsewhere");
    put(join(agent, "omp-compact", "index.ts"));
    put(join(agent, "config.yml"), "theme: dark\nextensions:\n  - omp-compact\n");
    expect(await installed({ PI_CODING_AGENT_DIR: agent }, h)).toEqual(["omp-compact"]);
  });

  test("a near-name or a deleted checkout is not installed", async () => {
    const h = home();
    put(join(h, "code", "cc-stretch", "stretch.ts"));
    put(join(h, "code", "omp-compact-notes", "x.ts"));
    put(join(h, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: ["~/code/cc-stretch/stretch.ts", "~/code/omp-compact-notes/x.ts", "~/gone/omp-stretch/stretch.ts"] }));
    expect(await installed({}, h)).toEqual([]);
  });

  test("broken files count as not found", async () => {
    const h = home();
    put(join(h, ".omp", "plugins", "installed_plugins.json"), "{ not json");
    put(join(h, ".omp", "agent", "settings.json"), "[1,");
    put(join(h, ".omp", "agent", "config.yml"), "extensions: [\n");
    expect(await installed({}, h)).toEqual([]);
  });

  test("AgentView counts when Waiting finds its CLI, through $CODEXBAR_WAITING or the Tern plugin's link", async () => {
    const h = home();
    const checkout = join(h, "codexbar-agentview");
    put(join(checkout, "contents", "scripts", "codexbar_waiting.py"));
    put(join(h, ".config", "tern", "plugins", "codexbar-agentview.path"), `${join(checkout, "tern")}\n`);
    expect(await installed({}, h)).toEqual(["codexbar-agentview"]);
    expect(await installed({ CODEXBAR_WAITING: join(h, "missing.py") }, h)).toEqual([]);
  });
});
