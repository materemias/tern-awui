import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { configDir, docIcon, installedExtension, ompDataDir, ternNotesDir } from "./paths";

const HOME = "/home/u";
const none = () => false;

describe("configDir", () => {
  test("~/.config/tern-mobile on every OS; $TERN_AWUI_CONFIG overrides", () => {
    expect(configDir({}, HOME)).toBe(join(HOME, ".config", "tern-mobile"));
    expect(configDir({ TERN_AWUI_CONFIG: "/etc/tm" }, HOME)).toBe("/etc/tm");
  });
});

describe("ompDataDir", () => {
  test("~/.omp/agent by default", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) expect(ompDataDir({}, HOME, platform, none)).toBe(join(HOME, ".omp", "agent"));
  });

  test("$TERN_AWUI_OMP_DIR wins over everything", () => {
    expect(ompDataDir({ TERN_AWUI_OMP_DIR: "/data/omp", PI_CODING_AGENT_DIR: "/x", XDG_DATA_HOME: "/xdg" }, HOME, "linux", () => true)).toBe(resolve("/data/omp"));
  });

  test("omp's own overrides: $PI_CODING_AGENT_DIR, $PI_CONFIG_DIR", () => {
    expect(ompDataDir({ PI_CODING_AGENT_DIR: "/agent" }, HOME, "linux", none)).toBe(resolve("/agent"));
    expect(ompDataDir({ PI_CONFIG_DIR: ".pi" }, HOME, "linux", none)).toBe(join(HOME, ".pi", "agent"));
  });

  test("$XDG_DATA_HOME/omp on Linux and macOS once it exists; never on Windows or with a custom agent dir", () => {
    const xdg = join("/xdg", "omp");
    const exists = (p: string) => p === xdg;
    expect(ompDataDir({ XDG_DATA_HOME: "/xdg" }, HOME, "linux", exists)).toBe(xdg);
    expect(ompDataDir({ XDG_DATA_HOME: "/xdg" }, HOME, "darwin", exists)).toBe(xdg);
    expect(ompDataDir({ XDG_DATA_HOME: "/xdg" }, HOME, "linux", none)).toBe(join(HOME, ".omp", "agent"));
    expect(ompDataDir({ XDG_DATA_HOME: "/xdg" }, HOME, "win32", exists)).toBe(join(HOME, ".omp", "agent"));
    expect(ompDataDir({ XDG_DATA_HOME: "/xdg", PI_CODING_AGENT_DIR: "/agent" }, HOME, "linux", exists)).toBe(resolve("/agent"));
  });
});

describe("installedExtension", () => {
  test("where install.ts links or copies it: ~/.omp/agent/extensions, or under $TERN_AWUI_OMP_DIR", () => {
    expect(installedExtension({}, HOME)).toBe(join(HOME, ".omp", "agent", "extensions", "tern-mobile.ts"));
    // omp's XDG data folder holds sessions, not extensions.
    expect(installedExtension({ XDG_DATA_HOME: "/xdg" }, HOME)).toBe(join(HOME, ".omp", "agent", "extensions", "tern-mobile.ts"));
    expect(installedExtension({ TERN_AWUI_OMP_DIR: "/data/omp" }, HOME)).toBe(join(resolve("/data/omp"), "extensions", "tern-mobile.ts"));
  });
});

describe("ternNotesDir", () => {
  test("Linux: $XDG_STATE_HOME/tern/notes, else ~/.local/state/tern/notes (a relative XDG value is ignored)", () => {
    expect(ternNotesDir({}, HOME, "linux")).toBe(join(HOME, ".local", "state", "tern", "notes"));
    expect(ternNotesDir({ XDG_STATE_HOME: "/state" }, HOME, "linux")).toBe(join("/state", "tern", "notes"));
    expect(ternNotesDir({ XDG_STATE_HOME: "state" }, HOME, "linux")).toBe(join(HOME, ".local", "state", "tern", "notes"));
  });

  test("macOS: Application Support; Windows: %LOCALAPPDATA%", () => {
    expect(ternNotesDir({}, HOME, "darwin")).toBe(join(HOME, "Library", "Application Support", "Tern", "notes"));
    expect(ternNotesDir({ LOCALAPPDATA: "/appdata" }, HOME, "win32")).toBe(join("/appdata", "Tern", "notes"));
    expect(ternNotesDir({}, HOME, "win32")).toBe(join(HOME, "AppData", "Local", "Tern", "notes"));
  });

  test("$TERN_AWUI_NOTES_DIR overrides on every OS", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) expect(ternNotesDir({ TERN_AWUI_NOTES_DIR: "/notes" }, HOME, platform)).toBe(resolve("/notes"));
  });
});

describe("docIcon", () => {
  test("notes, Markdown (any case) and other files get distinct glyphs", () => {
    const note = docIcon("/n/abc.md", true);
    const md = docIcon("/p/README.MD", false);
    const other = docIcon("/p/todo.txt", false);
    expect(new Set([note, md, other]).size).toBe(3);
    expect(docIcon("/p/a.markdown", false)).toBe(md);
    expect(docIcon("/p/md", false)).toBe(other);
  });
});
