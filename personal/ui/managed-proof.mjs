// Opt-in real-host proof. Requires caller-supplied pinned ILSpy and .NET SDK.
import assert from "node:assert/strict";
import { mkdir, cp, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { owned } from "../workbench/managed-restore.mjs";
import { requestSchema, runOperation } from "./operations.mjs";
const [dotnet, ilspy, destination] = process.argv.slice(2);
const root = resolve(destination);
await mkdir(root, { recursive: true });
const source = join(root, "fixture-source");
await cp(
  fileURLToPath(new URL("./fixtures/console", import.meta.url)),
  source,
  {
    recursive: true,
    filter: (path) => !path.includes("/obj") && !path.includes("/bin"),
  },
);
const original = join(root, "original");
const built = await owned(
  dotnet,
  [
    "build",
    join(source, "PersonalProbe.csproj"),
    "-c",
    "Release",
    "-o",
    original,
    "-p:UseSharedCompilation=false",
    "-nodeReuse:false",
  ],
  root,
  120000,
);
assert.equal(built.exitCode, 0, built.stderr.text);
const recovery = join(root, "recovery");
const originalDll = join(original, "PersonalProbe.dll");
const candidateDll = join(recovery, "rebuilt/PersonalProbe.dll");
const input = requestSchema.parse({
  action: "pipeline",
  target: original,
  project: join(root, "project"),
  assembly: originalDll,
  output: recovery,
  ilspy,
  dotnet,
  original: { executable: dotnet, arguments: [originalDll, "12", "30"] },
  candidate: { executable: dotnet, arguments: [candidateDll, "12", "30"] },
  cwd: root,
  timeout: 15000,
  executeAcknowledged: true,
});
const directory = join(root, "pipeline");
await mkdir(directory);
const record = (phase, status) => console.log(`${phase}: ${status}`);
const result = await runOperation(
  input,
  directory,
  record,
  new AbortController().signal,
);
await writeFile(
  join(root, "pipeline-result.json"),
  JSON.stringify(result, null, 2),
);
assert.equal(result.recovery.status, "rebuilt");
assert.equal(result.execution_observations.output_equal, true);
assert.equal(result.execution_observations.original_exit.code, 0);
assert.equal(result.execution_observations.candidate_exit.code, 0);
// A different output must be observable; canonical comparison remains unchanged by the UI.
const negative = join(root, "negative");
await mkdir(negative);
const changed = await runOperation(
  {
    ...input,
    action: "verify",
    candidate: { executable: dotnet, arguments: [candidateDll, "12", "31"] },
  },
  negative,
  record,
  new AbortController().signal,
);
assert.equal(changed.execution_observations.output_equal, false);
assert.equal(changed.comparison_status, "changed");
await writeFile(
  join(root, "negative-result.json"),
  JSON.stringify(changed, null, 2),
);
await rename(original, join(root, "original-quarantined"));
try {
  const independent = await owned(
    dotnet,
    [candidateDll, "12", "30"],
    root,
    15000,
  );
  assert.equal(independent.exitCode, 0);
  assert.equal(independent.stdout.text.trim(), "42");
  await writeFile(
    join(root, "independent-execution.json"),
    JSON.stringify(independent, null, 2),
  );
} finally {
  await rename(join(root, "original-quarantined"), original);
}
console.log(
  JSON.stringify({
    status: "passed",
    root,
    scope:
      "Real managed recovery, bounded output/exit observations, changed-output rejection, candidate executes with original folder absent. Canonical temporal/process comparison is retained separately.",
  }),
);
