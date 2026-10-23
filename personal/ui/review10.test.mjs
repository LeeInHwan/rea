import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "./server.mjs";
import { runOperation, bindOriginalCommand } from "./operations.mjs";
import { execute } from "../workbench/service.mjs";
import { withEngine } from "../workbench/engine.mjs";
import { compareObservations } from "./execution-observations.mjs";
import { fileDigest } from "../workbench/managed-restore.mjs";

test("late authenticated HTTP requests cannot mutate settings or release ownership across shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-http-drain-"));
  let ui, slow;
  try {
    ui = await startServer({ stateDir: root });
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ compiler: "/selected" }),
    );
    const login = await fetch(ui.url, { redirect: "manual" });
    const headers = {
      Cookie: login.headers.get("set-cookie").split(";")[0],
      Origin: ui.base,
      "Content-Type": "application/json",
      "X-REA-Request": "1",
    };
    const response = new Promise((resolve, reject) => {
      slow = http.request(
        ui.base + "/api/settings",
        {
          method: "POST",
          headers: { ...headers, Expect: "100-continue" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      slow.on("error", reject);
    });
    const continued = new Promise((resolve) => slow.once("continue", resolve));
    slow.flushHeaders();
    await continued;
    slow.write('{"compiler":');
    assert.equal(
      (
        await fetch(ui.base + "/api/shutdown", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    await assert.rejects(startServer({ stateDir: root }), /이미 실행 중/);
    slow.end('"/stale-setting"}');
    assert.equal(await response, 503);
    await ui.close();
    ui = await startServer({ stateDir: root });
    assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"))), {
      compiler: "/selected",
    });
  } finally {
    slow?.destroy();
    await ui?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real execution rejects an unused original argument; direct executable and explicit dotnet assembly remain bound",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-original-binding-"));
    try {
      const original = join(root, "original"),
        project = join(root, "project");
      await writeFile(
        join(root, "original.c"),
        '#include <stdio.h>\nint main(void){puts("ORIGINAL");return 0;}',
      );
      execFileSync("/usr/bin/cc", [join(root, "original.c"), "-o", original]);
      await execute("project_create", { project, target: original });
      const directory = join(root, "rejected"),
        accepted = join(root, "accepted");
      await mkdir(directory);
      await mkdir(accepted);
      const base = {
        action: "verify",
        project,
        cwd: root,
        timeout: 10000,
        executeAcknowledged: true,
      };
      const marker = join(root, "must-not-execute");
      await assert.rejects(
        runOperation(
          {
            ...base,
            original: {
              executable: process.execPath,
              arguments: [
                "-e",
                `require('fs').writeFileSync(${JSON.stringify(marker)},'executed')`,
                original,
              ],
            },
            candidate: { executable: original, arguments: [] },
          },
          directory,
          async () => {},
        ),
        /사용하지 않는 인자/,
      );
      await assert.rejects(readFile(marker), /ENOENT/);
      const result = await runOperation(
        {
          ...base,
          original: { executable: original, arguments: [] },
          candidate: { executable: original, arguments: [] },
        },
        accepted,
        async () => {},
      );
      assert.equal(result.original_binding.mode, "direct-executable");
      assert.equal(result.execution_observations.output_equal, true);
      const host = join(root, "dotnet"),
        assembly = join(root, "App.dll");
      await writeFile(host, "owned metadata-only host fixture");
      await writeFile(assembly, "owned metadata-only assembly fixture");
      const state = { target: { path: await realpath(assembly) } };
      const inventory = {
        normalized_result: { nodes: [{ sha256: await fileDigest(assembly) }] },
      };
      const input = {
        dotnet: host,
        original: { executable: host, arguments: [assembly] },
      };
      assert.equal(
        (await bindOriginalCommand(input, state, inventory)).mode,
        "dotnet-assembly",
      );
      await assert.rejects(
        bindOriginalCommand(
          {
            ...input,
            original: { executable: host, arguments: ["exec", assembly] },
          },
          state,
          inventory,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "real MCP incomplete UTF-8 and output truncation cannot establish output equivalence",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-capture-unknown-"));
    try {
      await withEngine(root, null, async (call) => {
        const scenario = {
          executable: process.execPath,
          working_directory: root,
          timeout_ms: 10000,
          settle_ms: 3000,
        };
        const incomplete = await call("capture_process_scenario", {
          ...scenario,
          arguments: ["-e", "process.stdout.write(Buffer.from([226,130]))"],
        });
        assert.ok(
          incomplete.normalized_result.residual_unknowns.some(
            (u) => u.scope === "terminal",
          ),
        );
        assert.equal(
          compareObservations(incomplete, incomplete).output_equal,
          null,
        );
        const truncated = await call("capture_process_scenario", {
          ...scenario,
          arguments: ["-e", "console.log('x'.repeat(10000))"],
          limits: { output_bytes: 128 },
        });
        assert.equal(truncated.normalized_result.truncated, true);
        assert.equal(
          compareObservations(truncated, truncated).output_equal,
          null,
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
