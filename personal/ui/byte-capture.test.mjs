import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEngine } from "../workbench/engine.mjs";
import { compareObservations } from "./execution-observations.mjs";

test(
  "real MCP capture never equates different invalid bytes; valid UTF-8 replacement stays comparable",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-byte-capture-"));
    try {
      await withEngine(root, null, async (call) => {
        const capture = (bytes) =>
          call("capture_process_scenario", {
            executable: process.execPath,
            arguments: [
              "-e",
              `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`,
            ],
            working_directory: root,
            timeout_ms: 15000,
            normalization: { paths: false, pids: false, ports: false },
          });
        const a = await capture([0x80, 10]),
          b = await capture([0x81, 10]);
        for (const value of [a, b])
          assert.ok(
            value.normalized_result.residual_unknowns.some(
              (u) => u.scope === "terminal" && u.reason.includes("UTF-8"),
            ),
          );
        assert.equal(compareObservations(a, b).output_equal, null);
        const c = await capture([0xef, 0xbf, 0xbd, 10]),
          d = await capture([0xef, 0xbf, 0xbd, 10]);
        assert.equal(compareObservations(c, d).output_equal, true);
        assert.equal(compareObservations(c, d).completed, true);
        const edited = await call("capture_process_scenario", {
          executable: process.execPath,
          arguments: [
            "-e",
            'process.stdin.once("data",b=>{console.log("VALUE="+b.toString("hex"));process.exit(0)});process.stdin.resume();',
          ],
          working_directory: root,
          timeout_ms: 15000,
          events: [
            {
              type: "input",
              at_ms: 1000,
              data:
                "한" + String.fromCharCode(127) + "X" + String.fromCharCode(10),
            },
          ],
          normalization: { paths: false, pids: false, ports: false },
        });
        assert.ok(
          edited.normalized_result.frames
            .map((f) => f.raw_data ?? f.data)
            .join("")
            .includes("VALUE=580a"),
          "UTF-8 canonical erase must preserve the input semantics",
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
