#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../../dist/process/OwnedCommand.js";
import { requireWindowsNativeAuthority } from "../../dist/windows/WindowsNativeLoader.js";
import { execute } from "./service.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "Execution proof requires an actual Windows x64 host; no simulation or WSL substitution.",
  );
const [originalArgument, changedArgument, reportArgument] =
  process.argv.slice(2);
if (!originalArgument || !changedArgument || !reportArgument)
  throw new Error(
    "Usage: windows-execution-proof.mjs original.exe changed.exe report.json",
  );
const original = resolve(originalArgument);
const changed = resolve(changedArgument);
const reportPath = resolve(reportArgument);
const workspace = await mkdtemp(join(tmpdir(), "rea-windows-workbench-"));
const report = {
  schema_version: 1,
  ok: false,
  host: {
    platform: process.platform,
    architecture: process.arch,
    release: release(),
    node: process.version,
  },
  authority: "production Windows Job Object owner",
  cases: [],
  controls: {},
  limitations: [
    "Finite owned native executable fixtures; not arbitrary Windows application or GUI equivalence.",
    "Native PTY capture remains unavailable; these are pipe-based execution records, not canonical process_capture Evidence.",
    "No Windows Ghidra, installer, or GUI reconstruction claim is made by this lane.",
  ],
};
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const run = (command, arguments_, timeoutMs = 10000, signal) =>
  runOwnedCommand(
    {
      command,
      arguments: arguments_,
      cwd: workspace,
      runId: `rea-windows-proof-${randomUUID()}`,
    },
    { timeoutMs, diagnosticBytes: 65536, acceptNonZeroExit: true },
    { signal },
  );
let failure;
try {
  report.native = requireWindowsNativeAuthority().inspection;
  report.original_sha256 = await digest(original);
  report.changed_sha256 = await digest(changed);
  assert.notEqual(report.original_sha256, report.changed_sha256);
  for (const input of [-10000, -1, 0, 1, 10000]) {
    const left = await run(original, [String(input)]);
    const same = await run(original, [String(input)]);
    const different = await run(changed, [String(input)]);
    for (const result of [left, same, different]) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.diagnosticTruncated, undefined);
      assert.equal(result.outputIncomplete, undefined);
      assert.equal(result.stdout.bytes, result.stdout.observedBytes);
      assert.equal(result.stderr.observedBytes, 0);
    }
    assert.equal(JSON.parse(left.stdout.text).result, input * 3 + 7);
    assert.equal(left.stdout.text, same.stdout.text);
    assert.notEqual(left.stdout.text, different.stdout.text);
    report.cases.push({
      input,
      original: left,
      repeat: same,
      changed: different,
      identical_control: "pass",
      changed_control: "detected",
    });
  }
  const nonzero = await run(original, ["fail"]);
  assert.equal(nonzero.exitCode, 7);
  assert.match(nonzero.stderr.text, /owned fixture failure/);
  report.controls.nonzero_exit = nonzero;
  for (const kind of ["timeout", "cancelled"]) {
    const controller = new AbortController();
    const timer =
      kind === "cancelled"
        ? setTimeout(() => controller.abort("owned fixture cancellation"), 1000)
        : undefined;
    try {
      await assert.rejects(
        run(
          original,
          ["wait"],
          kind === "timeout" ? 1000 : 10000,
          controller.signal,
        ),
        (cause) => {
          assert.ok(cause instanceof OwnedCommandFailure);
          assert.equal(cause.reason, kind);
          assert.equal(cause.cleanupFailure, null);
          assert.equal(cause.cleanupOwner, undefined);
          assert.deepEqual(cause.resources, []);
          assert.match(cause.snapshot.stdout.text, /started/);
          report.controls[kind] = {
            reason: cause.reason,
            snapshot: cause.snapshot,
            cleanup: "verified by production owner",
          };
          return true;
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  const client = new Client({
    name: "windows-capture-admission-proof",
    version: "1",
  });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
          "mcp",
        ],
        stderr: "inherit",
      }),
    );
    const denied = await client.callTool({
      name: "capture_process_scenario",
      arguments: { executable: original, arguments: ["0"] },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Windows PTY process capture/);
    report.controls.public_pty_capture = {
      status: "unsupported",
      refusal_verified: true,
    };
  } finally {
    await client.close();
  }
  const project = join(workspace, "project");
  const created = await execute("project_create", {
    project,
    target: original,
  });
  assert.equal(created.target.sha256, report.original_sha256);
  const resumed = await execute("project_resume", { project });
  assert.equal(resumed.target.sha256, report.original_sha256);
  report.controls.workbench_pe_checkpoint_resume = {
    original_sha256: resumed.target.sha256,
    revision: resumed.revision,
  };
  assert.equal(await digest(original), report.original_sha256);
  assert.equal(await digest(changed), report.changed_sha256);
  report.controls.original_and_candidate_bytes_preserved = true;
} catch (cause) {
  failure = cause;
  report.failure = {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
  };
} finally {
  try {
    await rm(workspace, { recursive: true, force: true });
    report.controls.workspace_cleanup = "removed";
  } catch (cause) {
    report.controls.workspace_cleanup = {
      status: "failed",
      reason: cause.message,
    };
    failure ??= cause;
  }
  report.ok = failure === undefined;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (failure) throw failure;
process.stdout.write(
  `${JSON.stringify({ ok: true, report: reportPath, cases: report.cases.length, host: report.host })}\n`,
);
