import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { repoOf } from "./git";

const root = realpathSync(mkdtempSync(`${tmpdir()}/tern-awui-git-`));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Isolated from the user's git config (hooks, signing, default branch).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: gitEnv });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
function repo(name: string): string {
  const dir = `${root}/${name}`;
  mkdirSync(`${dir}/src/deep`, { recursive: true });
  git(dir, "init", "-q", "-b", "trunk");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const project = async (cwd: string, home = "/home/nobody") => (await repoOf(cwd, home, () => {})).project;
const branch = async (cwd: string) => (await repoOf(cwd, "/home/nobody", () => {})).branch;

describe("project", () => {
  test("a folder inside a repo is named for the repo", async () => {
    const dir = repo("my-repo");
    expect(await project(`${dir}/src/deep`)).toBe("my-repo");
  });

  test("outside a repo, the folder's own name; home is ~", async () => {
    mkdirSync(`${root}/plain/inner`, { recursive: true });
    expect(await project(`${root}/plain/inner`)).toBe("inner");
    expect(await project(`${root}/plain`, `${root}/plain`)).toBe("~");
  });

  test("a missing folder still gets a name", async () => {
    expect(await project(`${root}/gone/away`)).toBe("away");
    expect(await project("/")).toBe("/");
  });

  test("a stale answer is served while git reruns; the change is reported, then served", async () => {
    const cwd = `${root}/new-project/src`;
    mkdirSync(cwd, { recursive: true });
    expect(await project(cwd, root)).toBe("src");
    git(`${root}/new-project`, "init", "-q");
    const changed = Promise.withResolvers<void>();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
    try {
      expect((await repoOf(cwd, root, changed.resolve)).project).toBe("src");
      await changed.promise;
      expect(await project(cwd, root)).toBe("new-project");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("branch", () => {
  test("the checked-out branch; a short sha when detached; the name on an unborn branch", async () => {
    const dir = repo("branchy");
    expect(await branch(dir)).toBe("trunk");
    // A tag with the branch's name makes `--abbrev-ref` say `heads/trunk`; the list shows the plain name.
    git(dir, "tag", "trunk");
    // A folder not looked up yet: the cache would otherwise answer from before the tag.
    expect(await branch(`${dir}/src/deep`)).toBe("trunk");
    const sha = git(dir, "rev-parse", "--short", "HEAD");
    git(dir, "checkout", "-q", "--detach");
    expect(await branch(`${dir}/src`)).toBe(sha);
    mkdirSync(`${root}/unborn`);
    git(`${root}/unborn`, "init", "-q", "-b", "fresh");
    expect(await branch(`${root}/unborn`)).toBe("fresh");
  });

  test("null outside a repo", async () => {
    mkdirSync(`${root}/norepo`, { recursive: true });
    expect(await branch(`${root}/norepo`)).toBeNull();
  });
});

test("without git on PATH: names from the folder, no branch", () => {
  const dir = repo("hidden-repo");
  const script = `import { repoOf } from ${JSON.stringify(`${import.meta.dir}/git.ts`)};
console.log(JSON.stringify(await repoOf(${JSON.stringify(`${dir}/src`)}, "/h", () => {})));`;
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/nonexistent", HOME: root } });
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual({ project: "src", branch: null });
});
