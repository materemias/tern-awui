import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { branchOf, projectOf } from "./git";

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

describe("projectOf", () => {
  test("a folder inside a repo is named for the repo", () => {
    const dir = repo("my-repo");
    expect(projectOf(`${dir}/src/deep`, "/home/nobody")).toBe("my-repo");
  });

  test("outside a repo, the folder's own name; home is ~", () => {
    mkdirSync(`${root}/plain/inner`, { recursive: true });
    expect(projectOf(`${root}/plain/inner`, "/home/nobody")).toBe("inner");
    expect(projectOf(`${root}/plain`, `${root}/plain`)).toBe("~");
  });

  test("a missing folder still gets a name", () => {
    expect(projectOf(`${root}/gone/away`, "/home/nobody")).toBe("away");
    expect(projectOf("/", "/home/nobody")).toBe("/");
  });
});

describe("branchOf", () => {
  test("the checked-out branch; a short sha when detached", () => {
    const dir = repo("branchy");
    expect(branchOf(dir)).toBe("trunk");
    const sha = git(dir, "rev-parse", "--short", "HEAD");
    git(dir, "checkout", "-q", "--detach");
    expect(branchOf(`${dir}/src`)).toBe(sha);
  });

  test("null outside a repo", () => {
    mkdirSync(`${root}/norepo`, { recursive: true });
    expect(branchOf(`${root}/norepo`)).toBeNull();
  });
});

test("without git on PATH: names from the folder, no branch", () => {
  const dir = repo("hidden-repo");
  const script = `import { projectOf, branchOf } from ${JSON.stringify(`${import.meta.dir}/git.ts`)};
console.log(JSON.stringify([projectOf(${JSON.stringify(`${dir}/src`)}, "/h"), branchOf(${JSON.stringify(dir)})]));`;
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/nonexistent", HOME: root } });
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual(["src", null]);
});
