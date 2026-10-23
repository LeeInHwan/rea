import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSources,
  compareObservations,
  nativeDenyProfile,
  guardedNativeCommand,
} from "./native-recovery.mjs";
import { mkdtemp, realpath, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { owned } from "../workbench/managed-restore.mjs";
import { requestSchema } from "./operations.mjs";
const source = {
  files: [{ name: "main.c", content: "int main(void){return 0;}" }],
  functions: [{ address: "0x1", implementation: "main" }],
  unknowns: [],
  derivations: [],
};
test("model output cannot escape source directory or forge coverage", () => {
  assert.deepEqual(validateSources(source, ["0x1"]).missing, []);
  for (const name of ["../a.c", "/tmp/a.c", "a.sh", "-x.c"])
    assert.throws(() =>
      validateSources({ ...source, files: [{ name, content: "x" }] }, ["0x1"]),
    );
  assert.throws(() =>
    validateSources(
      { ...source, functions: [{ address: "0x2", implementation: "x" }] },
      ["0x1"],
    ),
  );
  assert.deepEqual(
    validateSources({ ...source, functions: [] }, ["0x1"]).missing,
    ["0x1"],
  );
});
test("timeouts and truncated matching output do not establish completed equivalence", () => {
  const capture = {
    normalized_result: {
      frames: [{ data: "ok" }],
      exit: { code: 0, signal: null, reason: "exited" },
      truncated: false,
      settlement: { state: "quiesced" },
    },
  };
  assert.equal(compareObservations(capture, capture).completed, true);
  const unsettled = structuredClone(capture);
  unsettled.normalized_result.settlement.state = "alive_at_deadline";
  assert.equal(compareObservations(unsettled, unsettled).completed, false);
  const rawLeft = structuredClone(capture);
  const rawRight = structuredClone(capture);
  rawLeft.normalized_result.frames[0].raw_data = "pid=123";
  rawRight.normalized_result.frames[0].raw_data = "pid=456";
  assert.equal(compareObservations(rawLeft, rawRight).output_equal, false);
  const timeout = structuredClone(capture);
  timeout.normalized_result.exit.reason = "timeout";
  assert.equal(compareObservations(timeout, timeout).completed, false);
  const truncated = structuredClone(capture);
  truncated.normalized_result.truncated = true;
  assert.equal(compareObservations(truncated, truncated).output_equal, null);
});
test("runtime and model transfer consent are independent API gates", () => {
  const input = {
    action: "native_recover",
    project: "/tmp/p",
    output: "/tmp/o",
    compiler: "/usr/bin/cc",
    codex: "/tmp/codex",
    cwd: "/tmp",
  };
  assert.equal(requestSchema.safeParse(input).success, false);
  assert.equal(
    requestSchema.safeParse({ ...input, executeAcknowledged: true }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({
      ...input,
      executeAcknowledged: true,
      modelAcknowledged: true,
    }).success,
    true,
  );
  const apk = {
    action: "apk_verify",
    project: "/tmp/p",
    apkCandidate: "/tmp/a.apk",
    androidSdk: "/tmp/sdk",
    java: "/tmp/java",
    serial: "emulator-5580",
    avdName: "personal_rea_api35",
  };
  assert.equal(requestSchema.safeParse(apk).success, false);
  assert.equal(
    requestSchema.safeParse({ ...apk, executeAcknowledged: true }).success,
    true,
  );
});

const darwinOnly = { skip: process.platform !== "darwin", timeout: 120000 };
const clang = "/usr/bin/clang";

async function fixtureDirectory(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rea-native-denial-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function runGuarded(command, args, directory, profile) {
  const invocation = guardedNativeCommand(command, args, profile);
  return owned(invocation.command, invocation.arguments, directory, 30000);
}
function succeeded(result) {
  assert.equal(result.exitCode, 0, result.stderr.text);
  assert.notEqual(result.diagnosticTruncated, true);
}
async function nativeFixtures(directory) {
  const source = join(directory, "original.c");
  const original = join(directory, "registered-original");
  const snapshot = join(directory, "analysis-snapshot");
  await writeFile(
    source,
    '#include <stdio.h>\nint main(void){puts("ORIGINAL_EXECUTED");return 0;}\n',
  );
  succeeded(
    await owned(clang, ["-std=c11", source, "-o", original], directory, 30000),
  );
  await copyFile(original, snapshot);
  return {
    original,
    snapshot,
    profile: nativeDenyProfile([original, snapshot]),
  };
}

test(
  "macOS candidate cannot exec either registered original or analysis snapshot",
  darwinOnly,
  async (t) => {
    const directory = await fixtureDirectory(t);
    const { original, snapshot, profile } = await nativeFixtures(directory);
    const source = join(directory, "forwarder.c");
    const forwarder = join(directory, "forwarder");
    await writeFile(
      source,
      `#include <unistd.h>
#include <errno.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *args[] = {argv[1], NULL};
  execv(argv[1], args);
  if (errno == EPERM || errno == EACCES) { puts("EXECUTION_BLOCKED"); return 77; }
  perror("execv"); return 78;
}
`,
    );
    succeeded(
      await owned(
        clang,
        ["-std=c11", source, "-o", forwarder],
        directory,
        30000,
      ),
    );
    for (const target of [original, snapshot]) {
      const baseline = await owned(forwarder, [target], directory, 30000);
      succeeded(baseline);
      assert.equal(baseline.stdout.text.trim(), "ORIGINAL_EXECUTED");
      const denied = await runGuarded(forwarder, [target], directory, profile);
      assert.equal(denied.exitCode, 77, denied.stderr.text);
      assert.equal(denied.stdout.text.trim(), "EXECUTION_BLOCKED");
      assert.notEqual(denied.diagnosticTruncated, true);
    }
  },
);

test(
  "macOS compiler cannot embed original bytes with inline assembly incbin",
  darwinOnly,
  async (t) => {
    const directory = await fixtureDirectory(t);
    const { original, snapshot, profile } = await nativeFixtures(directory);
    for (const [index, target] of [original, snapshot].entries()) {
      const source = join(directory, `embed-${index}.c`);
      const assembly = `.section __DATA,__data\n.globl _rea_embedded_fixture\n_rea_embedded_fixture:\n.incbin "${target}"\n`;
      await writeFile(source, `__asm__(${JSON.stringify(assembly)});\n`);
      const common = ["-x", "c", "-std=c11", "-c", source, "-o"];
      succeeded(
        await owned(
          clang,
          [...common, join(directory, `baseline-${index}.o`)],
          directory,
          30000,
        ),
      );
      const denied = await runGuarded(
        clang,
        [...common, join(directory, `denied-${index}.o`)],
        directory,
        profile,
      );
      assert.notEqual(denied.exitCode, 0);
      assert.match(
        denied.stderr.text,
        /[Oo]peration not permitted|[Pp]ermission denied|Could not find incbin file/,
      );
      assert.ok(
        denied.stderr.text.includes(target),
        "diagnostic identifies the denied source bytes",
      );
      assert.notEqual(denied.diagnosticTruncated, true);
    }
  },
);

test(
  "macOS guard permits C++ standard-library compile, explicit link and execution",
  darwinOnly,
  async (t) => {
    const directory = await fixtureDirectory(t);
    const { profile } = await nativeFixtures(directory);
    const source = join(directory, "normal.cpp");
    const object = join(directory, "normal.o");
    const executable = join(directory, "normal");
    await writeFile(
      source,
      `#include <iostream>
#include <numeric>
#include <vector>
int main() {
  const std::vector<int> values{1, 2, 3};
  std::cout << std::accumulate(values.begin(), values.end(), 0) << "\\n";
}
`,
    );
    succeeded(
      await runGuarded(
        clang,
        ["-x", "c++", "-std=c++17", "-O0", "-c", source, "-o", object],
        directory,
        profile,
      ),
    );
    succeeded(
      await runGuarded(
        clang,
        [object, "-lc++", "-o", executable],
        directory,
        profile,
      ),
    );
    const result = await runGuarded(executable, [], directory, profile);
    succeeded(result);
    assert.equal(result.stdout.text, "6\n");
  },
);
