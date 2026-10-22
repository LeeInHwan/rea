import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, integrateRelease } from "./update.mjs";

test("real Git updater: no-op, dirty refusal, qualification failure, concurrent edits, successful activation and preserved old runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-update-test-"));
  const repo = join(root, "repo");
  const runtime = join(root, "current");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "REA updater test");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await writeFile(join(repo, "README"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fixture base");
    const base = git(repo, "rev-parse", "HEAD");
    assert.equal(
      (
        await integrateRelease({
          repo,
          target: base,
          runtime,
          qualify: async () => assert.fail("should not qualify"),
        })
      ).status,
      "up-to-date",
    );
    git(repo, "checkout", "-b", "upstream");
    await writeFile(join(repo, "README"), "release\n");
    git(repo, "commit", "-am", "fixture release");
    const target = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");
    await writeFile(join(repo, "dirty"), "user work");
    await assert.rejects(
      integrateRelease({ repo, target, runtime, qualify: async () => {} }),
      /local changes/,
    );
    await rm(join(repo, "dirty"));
    await assert.rejects(
      integrateRelease({
        repo,
        target,
        runtime,
        qualify: async () => {
          throw new Error("incompatible MCP contract");
        },
      }),
      /incompatible MCP/,
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    await assert.rejects(readlink(runtime), /ENOENT/);
    await assert.rejects(
      integrateRelease({
        repo,
        target,
        runtime,
        qualify: async () => {
          await writeFile(join(repo, "dirty"), "concurrent user work");
        },
      }),
      /local changes/,
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    await rm(join(repo, "dirty"));
    const passed = await integrateRelease({
      repo,
      target,
      runtime,
      qualify: async () => {},
    });
    assert.equal(passed.status, "activated");
    assert.equal(git(repo, "rev-parse", "HEAD"), passed.candidate);
    assert.equal(await readlink(runtime), passed.checkout);
    assert.equal(git(repo, "rev-parse", passed.backup_ref), base);
    assert.equal(
      (
        await integrateRelease({
          repo,
          target,
          runtime,
          qualify: async () => assert.fail(),
        })
      ).status,
      "up-to-date",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
