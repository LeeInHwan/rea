#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  rename,
  lstat,
  readlink,
} from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const isAncestor = (repo, ancestor, child) => {
  try {
    git(repo, "merge-base", "--is-ancestor", ancestor, child);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};
function assertCleanMain(repo, expected) {
  if (git(repo, "branch", "--show-current") !== "main")
    throw new Error("Update deferred: checkout is not main");
  if (git(repo, "status", "--porcelain"))
    throw new Error("Update deferred: checkout has local changes");
  if (expected && git(repo, "rev-parse", "HEAD") !== expected)
    throw new Error("Update deferred: main changed during qualification");
}
export async function activateRuntime(pointer, checkout) {
  await mkdir(dirname(pointer), { recursive: true });
  let previous = null;
  try {
    if (!(await lstat(pointer)).isSymbolicLink())
      throw new Error("Runtime pointer exists and is not a symlink");
    previous = await readlink(pointer);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${pointer}.${randomUUID()}`;
  await symlink(checkout, temporary, "dir");
  await rename(temporary, pointer);
  return previous;
}
export async function integrateRelease({
  repo,
  target,
  runtime,
  qualify,
  publish = false,
}) {
  const base = git(repo, "rev-parse", "HEAD");
  const commit = git(repo, "rev-parse", `${target}^{commit}`);
  if (isAncestor(repo, commit, base))
    return { status: "up-to-date", head: base, release_commit: commit };
  assertCleanMain(repo, base);
  const common = resolve(repo, git(repo, "rev-parse", "--git-common-dir"));
  const lock = join(common, "personal-update.lock");
  await mkdir(lock); // Never take over an interrupted updater's lock by PID alone.
  const run = join(
    common,
    "personal-updates",
    `${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const checkout = join(run, "runtime");
  const receipt = {
    status: "staging",
    base,
    release_commit: commit,
    checkout,
    started_at: new Date().toISOString(),
  };
  await mkdir(run, { recursive: true });
  const record = () =>
    writeFile(
      join(run, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  try {
    await record();
    git(repo, "worktree", "add", "--detach", checkout, base);
    git(
      checkout,
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "--no-edit",
      commit,
    );
    receipt.candidate = git(checkout, "rev-parse", "HEAD");
    await qualify(checkout, run);
    if (git(checkout, "status", "--porcelain"))
      throw new Error(
        "Qualification modified tracked files or left untracked files",
      );
    if (git(checkout, "rev-parse", "HEAD") !== receipt.candidate)
      throw new Error("Candidate commit changed during qualification");
    assertCleanMain(repo, base);
    if (
      publish &&
      git(repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0] !==
        base
    )
      throw new Error("Remote main diverged; automatic overwrite refused");
    receipt.backup_ref = `refs/heads/backup/rea-update-${Date.now()}-${base.slice(0, 8)}`;
    git(repo, "update-ref", receipt.backup_ref, base);
    git(
      repo,
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--ff-only",
      receipt.candidate,
    );
    receipt.status = "source-promoted";
    await record();
    receipt.previous_runtime = await activateRuntime(runtime, checkout);
    receipt.status = "activated";
    await record();
    if (publish) {
      // Checks ran in the immutable runtime; source checkout dist may still be older.
      git(repo, "-c", "core.hooksPath=/dev/null", "push", "origin", "main");
      receipt.status = "published";
    }
    receipt.finished_at = new Date().toISOString();
    await record();
    return receipt;
  } catch (error) {
    receipt.failure_stage = receipt.status;
    receipt.status = "failed";
    receipt.error = error.message;
    await record();
    throw new Error(
      `${error.message}\nUpdate receipt: ${join(run, "receipt.json")}`,
    );
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function qualifyRuntime(checkout, run) {
  const pinned = (await readFile(join(checkout, ".nvmrc"), "utf8")).trim();
  if (process.versions.node !== pinned)
    throw new Error(
      `Node ${pinned} is required. Automatic toolchain installation is disabled.`,
    );
  const metadata = JSON.parse(
    await readFile(join(checkout, "package.json"), "utf8"),
  );
  const npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
  }).trim();
  if (`npm@${npmVersion}` !== metadata.packageManager)
    throw new Error(`Required package manager: ${metadata.packageManager}`);
  const tests = [
    "tests/acceptance/emptyTargetPathCli.test.ts",
    "tests/boundary/mcp/artifactMcp.test.ts",
    "tests/boundary/providers/native/artifactProvider.extractionFormat.test.ts",
    "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
    "tests/boundary/cli/evidenceBundleCommands.test.ts",
    "tests/boundary/filesystem/evidenceBundleFiles.test.ts",
  ];
  const steps = [
    ["npm", ["ci"]],
    ["npm", ["run", "build:cached"]],
    [
      process.execPath,
      [
        "--test",
        "personal/workbench/workbench.test.mjs",
        "personal/workbench/update.test.mjs",
        "personal/workbench/managed-restore.test.mjs",
        "personal/ui/server.test.mjs",
      ],
    ],
    ["npm", ["run", "test:focused", "--", ...tests]],
    ["npm", ["run", "check:fast"]],
    ["npm", ["run", "docs:check"]],
  ];
  for (const [index, [command, args]] of steps.entries()) {
    process.stderr.write(
      `REA update qualification ${index + 1}/${steps.length}: ${command} ${args.join(" ")}\n`,
    );
    const descriptor = openSync(
      join(run, `check-${index + 1}.log`),
      "w",
      0o600,
    );
    try {
      execFileSync(command, args, {
        cwd: checkout,
        env: { ...process.env, HUSKY: "0" },
        stdio: ["ignore", descriptor, descriptor],
      });
    } finally {
      closeSync(descriptor);
    }
  }
}

async function main() {
  const option = process.argv[2] ?? "--check";
  if (!["--check", "--apply"].includes(option))
    throw new Error("Usage: update.mjs --check | --apply");
  // Explicit trusted upstream, never whichever repository an arbitrary remote points at.
  const release = JSON.parse(
    execFileSync("gh", ["api", "repos/morluto/rea/releases/latest"], {
      encoding: "utf8",
    }),
  );
  if (
    release.draft ||
    release.prerelease ||
    !/^rea-agents-\d+\.\d+\.\d+$/.test(release.tag_name)
  )
    throw new Error("Latest release is not a supported stable REA release");
  git(
    root,
    "fetch",
    "--no-tags",
    "https://github.com/morluto/rea.git",
    `refs/tags/${release.tag_name}`,
  );
  const target = git(root, "rev-parse", "FETCH_HEAD^{commit}");
  if (option === "--check") {
    console.log(
      JSON.stringify(
        {
          release: release.tag_name,
          url: release.html_url,
          release_commit: target,
          update_needed: !isAncestor(root, target, "HEAD"),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    git(root, "remote", "get-url", "origin") !==
    "https://github.com/LeeInHwan/rea.git"
  )
    throw new Error("Unexpected personal fork origin; automatic push refused");
  console.log(
    JSON.stringify(
      await integrateRelease({
        repo: root,
        target,
        runtime: join(homedir(), ".local/share/rea-personal/current"),
        qualify: qualifyRuntime,
        publish: true,
      }),
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
