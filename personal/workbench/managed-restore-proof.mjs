import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, cp, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { owned, fileDigest } from "./managed-restore.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Requires native Windows x64");
const [ilspy, dotnet, destination] = process.argv.slice(2);
const root = resolve(destination);
await mkdir(root, { recursive: true });
const report = {
  schema_version: 1,
  platform: process.platform,
  status: "running",
  scope:
    "Project-owned single-assembly Windows Forms reference app; finite UI and persistence scenarios, not arbitrary application equivalence",
  commands: [],
};
const record = () =>
  writeFile(join(root, "proof.json"), JSON.stringify(report, null, 2));
const run = async (name, command, args) => {
  const result = await owned(command, args, root, 300000);
  await writeFile(join(root, `${name}.json`), JSON.stringify(result, null, 2));
  report.commands.push({ name, exit_code: result.exitCode });
  await record();
  return result;
};
const build = async (name, project, output) => {
  const result = await run(name, dotnet, [
    "build",
    project,
    "-c",
    "Release",
    "-o",
    output,
    "-p:UseSharedCompilation=false",
    "-nodeReuse:false",
  ]);
  assert.equal(
    result.exitCode,
    0,
    `${name}: ${result.stdout.text} ${result.stderr.text}`,
  );
};
const original = join(root, "original");
const recovered = join(root, "recovered");
const fixture = fileURLToPath(
  new URL("./fixtures/managed-app/PersonalCalc.csproj", import.meta.url),
);
const powershell = join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const uiScript = fileURLToPath(
  new URL("./managed-ui-proof.ps1", import.meta.url),
);
const ui = (name, deployment) =>
  run(name, powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    uiScript,
    "-AppExe",
    join(deployment, "PersonalCalc.exe"),
    "-DataDirectory",
    join(root, `${name}-data`),
  ]);
const client = new Client({
  name: "managed-recovery-conformance",
  version: "0.2.0",
});
try {
  await build("build-original", fixture, original);
  report.original_sha256 = await fileDigest(join(original, "PersonalCalc.dll"));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "mcp"],
      env: { ...process.env },
      stderr: "inherit",
    }),
  );
  const call = async (name, args) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 900000 },
    );
    if (response.isError) throw new Error(JSON.stringify(response.content));
    return (
      response.structuredContent ??
      JSON.parse(response.content.find((part) => part.type === "text").text)
    );
  };
  const project = join(root, "project");
  await call("project_create", { project, target: original });
  report.recovery = await call("restore_managed_application", {
    project,
    assembly_path: join(original, "PersonalCalc.dll"),
    output_directory: recovered,
    ilspy_command: resolve(ilspy),
    dotnet_command: resolve(dotnet),
    timeout_ms: 300000,
  });
  assert.equal(report.recovery.status, "rebuilt");
  assert.equal(report.recovery.behavior, "not-run");
  await call("project_export", { project, destination: join(root, "export") });
  report.rebuilt_sha256 = await fileDigest(
    join(recovered, "rebuilt", "PersonalCalc.dll"),
  );
  assert.notEqual(report.rebuilt_sha256, report.original_sha256);
  const baseline = await ui("original-ui", original);
  assert.equal(baseline.exitCode, 0, baseline.stderr.text);
  report.original_ui = JSON.parse(baseline.stdout.text);
  // Make original deployment and the copied input unavailable at their recovery paths.
  await rename(original, join(root, "quarantined-original"));
  await rename(join(recovered, "input"), join(root, "quarantined-input"));
  try {
    const candidate = await ui("recovered-ui", join(recovered, "rebuilt"));
    assert.equal(candidate.exitCode, 0, candidate.stderr.text);
    report.recovered_ui = JSON.parse(candidate.stdout.text);
    assert.deepEqual(report.recovered_ui, report.original_ui);
    assert.equal(
      await readFile(join(root, "recovered-ui-data", "memo.txt"), "utf8"),
      "REA unicode 한글 42",
    );
    report.original_unavailable_during_candidate_run = true;
  } finally {
    await rename(join(root, "quarantined-original"), original);
    await rename(join(root, "quarantined-input"), join(recovered, "input"));
  }
  // Independent negative control proves the UI oracle detects changed calculations.
  const brokenSource = join(root, "broken-source");
  await mkdir(brokenSource);
  await cp(fixture, join(brokenSource, "PersonalCalc.csproj"));
  const originalCode = await readFile(
    fileURLToPath(
      new URL("./fixtures/managed-app/Program.cs", import.meta.url),
    ),
    "utf8",
  );
  assert.ok(originalCode.includes("first + second"));
  await writeFile(
    join(brokenSource, "Program.cs"),
    originalCode.replace("first + second", "first - second"),
  );
  await build(
    "build-negative-control",
    join(brokenSource, "PersonalCalc.csproj"),
    join(root, "broken"),
  );
  const negative = await ui("negative-ui", join(root, "broken"));
  assert.notEqual(negative.exitCode, 0);
  assert.match(
    negative.stderr.text,
    /integer addition expected <42> but observed <-18>/,
  );
  report.negative_control = "changed calculation rejected";
  assert.equal(
    await fileDigest(join(original, "PersonalCalc.dll")),
    report.original_sha256,
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  await client.close();
  await record();
}
console.log(JSON.stringify(report));
