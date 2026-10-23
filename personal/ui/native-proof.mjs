// Opt-in real compiler + Ghidra + authenticated Codex proof. No original source is sent to the model.
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { owned, fileDigest } from "../workbench/managed-restore.mjs";
import { runOperation, requestSchema } from "./operations.mjs";
import { withEngine } from "../workbench/engine.mjs";
import { compareObservations } from "./native-recovery.mjs";
if (!process.argv[2])
  throw new Error("Usage: node native-proof.mjs NEW_DIRECTORY");
const root = resolve(process.argv[2]);
await mkdir(root, { mode: 0o700 });
const originalDir = join(root, "original");
await mkdir(originalDir);
const source = join(originalDir, "fixture.c"),
  binary = join(originalDir, "fixture");
await writeFile(
  source,
  `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int score(int x) { if(x<0) return -x+7; if(x%2==0) return x*3+2; return x*5-1; }
int main(int argc,char **argv) {
 if(argc!=3){puts("usage: fixture score|echo VALUE");return 2;}
 if(strcmp(argv[1],"score")==0){char *end;long n=strtol(argv[2],&end,10);if(*end||n < -1000 || n > 1000){puts("invalid number");return 3;}printf("score=%d\\n",score((int)n));return 0;}
 if(strcmp(argv[1],"echo")==0){printf("value[%zu]=%s\\n",strlen(argv[2]),argv[2]);return 0;}
 puts("unknown command");return 4;
}
`,
);
assert.equal(
  (await owned("/usr/bin/clang", ["-O0", source, "-o", binary], root, 120000))
    .exitCode,
  0,
);
const sourceHash = await fileDigest(source);
const run = async (name, input) => {
  const dir = join(root, name);
  await mkdir(dir);
  return runOperation(requestSchema.parse(input), dir, async (s, t) =>
    process.stderr.write(`${name}: ${s} ${t}\n`),
  );
};
const project = join(root, "project");
await run("inventory", { action: "analyze", target: binary, project });
const cases = [
  { name: "usage", args: [] },
  { name: "even", args: ["score", "4"] },
  { name: "negative", args: ["score", "-8"] },
  { name: "text", args: ["echo", "Hello REA"] },
];
const result = await run("recovery", {
  action: "native_recover",
  project,
  output: join(root, "recovered"),
  compiler: "/usr/bin/clang++",
  codex: process.env.CODEX_COMMAND || join(homedir(), ".local/bin/codex"),
  cwd: root,
  nativeCases: cases,
  attempts: 2,
  executeAcknowledged: true,
  modelAcknowledged: true,
});
await writeFile(
  join(root, "proof.json"),
  JSON.stringify({ source_hash_not_sent: sourceHash, result }, null, 2),
);
assert.equal(result.native.status, "verified");
const dir = join(root, "heldout");
await mkdir(dir);
const heldout = await withEngine(dir, null, async (call) => {
  const results = [];
  for (const args of [
    ["score", "9"],
    ["score", "0"],
    ["score", "-37"],
    ["score", "bad"],
    ["score", "1001"],
    ["echo", ""],
    ["bogus", "x"],
  ]) {
    const capture = (executable) =>
      call("capture_process_scenario", {
        executable,
        arguments: args,
        working_directory: root,
        timeout_ms: 15000,
        finalization_ms: 500,
      });
    const left = await capture(binary),
      right = await capture(result.native.candidate);
    const observation = compareObservations(left, right);
    assert.equal(observation.completed, true);
    assert.equal(observation.output_equal, true);
    assert.equal(observation.exit_equal, true);
    results.push({ args, ...observation });
  }
  return results;
});
await rename(originalDir, join(root, "original-unavailable"));
const independent = await owned(
  result.native.candidate,
  ["score", "9"],
  root,
  15000,
);
assert.equal(independent.exitCode, 0);
assert.match(independent.stdout.text, /score=44/);
const negative = await owned(
  result.native.candidate,
  ["score", "10"],
  root,
  15000,
);
assert.notEqual(negative.stdout.text, independent.stdout.text);
await writeFile(
  join(root, "proof.json"),
  JSON.stringify(
    {
      source_hash_not_sent: sourceHash,
      result,
      heldout: heldout.result,
      independent,
      negative_control: negative,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    status: "verified",
    candidate: result.native.candidate,
    heldout: heldout.result.length,
    receipt: join(root, "proof.json"),
  }),
);
