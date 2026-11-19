// Which of the projects tern-awui works best with this desktop has installed, for the About window.
// It says only whether each is installed: a plugin can sit in omp's folder and still be switched
// off, and an omp started before the install hasn't loaded it. Read on each request, no watcher:
// a few small local files, read asynchronously so a stalled mount can't hold up the server.
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { obj } from "./json";
import { ompAgentDir, ompRoot } from "./paths";
import { locateWaitingCli } from "./waiting";

type Env = Record<string, string | undefined>;

export const COMPANION_IDS = ["omp-stretch", "codexbar-agentview", "omp-compact"] as const;
export type CompanionId = (typeof COMPANION_IDS)[number];
/** What `/api/companions` answers per project: no paths, nothing else from the desktop. */
export type Companion = { id: CompanionId; installed: boolean };

/**
 * omp's settings folders (`settings.json`, `config.yml`): its agent folder, plus `$TERN_AWUI_OMP_DIR`
 * when set (where install.ts puts tern-mobile.ts). Plugins live in `<root>/plugins`, or
 * `$XDG_DATA_HOME/omp/plugins` once omp moved its data there; both are looked at.
 */
function ompDirs(env: Env, home: string): { agents: string[]; plugins: string[] } {
  const agents = [ompAgentDir(env, home)];
  if (env.TERN_AWUI_OMP_DIR) agents.push(resolve(env.TERN_AWUI_OMP_DIR));
  const plugins = [join(ompRoot(env, home), "plugins")];
  if (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) plugins.push(join(env.XDG_DATA_HOME, "omp", "plugins"));
  return { agents, plugins };
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** A parsed file, or undefined when it is missing, unreadable or doesn't parse. */
async function parsed(path: string, parse: (text: string) => unknown): Promise<unknown> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The extension paths omp loads by name that still exist: `extensions` in each agent folder's
 * settings.json and config.yml, `~/` expanded and relative paths taken from that folder, with `/`
 * as separator.
 */
async function extensionEntries(agents: string[], home: string): Promise<string[]> {
  const entries: string[] = [];
  for (const dir of agents) {
    for (const config of await Promise.all([parsed(join(dir, "settings.json"), JSON.parse), parsed(join(dir, "config.yml"), Bun.YAML.parse)])) {
      const list = obj(config).extensions;
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (typeof e !== "string") continue;
        const path = e.startsWith("~/") ? join(home, e.slice(2)) : /^[A-Za-z]:[\\/]/.test(e) ? e : resolve(dir, e);
        if (await exists(path)) entries.push(path.replaceAll("\\", "/"));
      }
    }
  }
  return entries;
}

/** An omp plugin installed from a marketplace (`key` in installed_plugins.json, with an install) or as a package (`node_modules/<pkg>`). */
async function ompPlugin(plugins: string[], key: string, pkg: string): Promise<boolean> {
  for (const dir of plugins) {
    if (await exists(join(dir, "node_modules", pkg))) return true;
    const installs = obj(obj(await parsed(join(dir, "installed_plugins.json"), JSON.parse)).plugins)[key];
    if (Array.isArray(installs) && installs.length) return true;
  }
  return false;
}

/** Whether an extension path is the project's folder or a file in it (`…/omp-compact/…`), not a near-name. */
const inFolder = (entries: string[], folder: string) => entries.some((e) => new RegExp(`(^|/)${folder}(/|$)`).test(e));

/**
 * Each companion, installed or not found. omp-stretch and omp-compact count once omp has them as a
 * plugin or an extension path that exists; AgentView counts when the Waiting list can find its CLI
 * (the same lookup as `lib/waiting.ts`), since that is what the app uses of it.
 */
export async function companions(env: Env, home: string): Promise<Companion[]> {
  const { agents, plugins } = ompDirs(env, home);
  const entries = await extensionEntries(agents, home);
  const [stretch, compact] = await Promise.all([ompPlugin(plugins, "omp-stretch@omp-stretch", "omp-stretch"), ompPlugin(plugins, "omp-compact@arksdev", "omp-compact")]);
  const installed: Record<CompanionId, boolean> = {
    "omp-stretch": stretch || inFolder(entries, "omp-stretch"),
    "codexbar-agentview": locateWaitingCli(env, home) !== null,
    "omp-compact": compact || inFolder(entries, "omp-compact"),
  };
  return COMPANION_IDS.map((id) => ({ id, installed: installed[id] }));
}
