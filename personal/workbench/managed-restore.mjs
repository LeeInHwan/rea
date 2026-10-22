import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve, basename, isAbsolute } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import {
  runOwnedCommand,
  prepareOwnedCommand,
} from "../../dist/process/OwnedCommand.js";
import { assertOutsideTarget, json, sha256 } from "./store.mjs";

export const ILSPY_VERSION = "11.1.0.9782";
// Retain unresolved cleanup ownership for the lifetime of the tool server.
const cleanupOwners = new Set();
export async function owned(command, args, cwd, timeoutMs, signal) {
  await prepareOwnedCommand(signal);
  return runOwnedCommand(
    { command, arguments: args, cwd, runId: `rea-managed-${randomUUID()}` },
    { timeoutMs, diagnosticBytes: 2 * 1024 * 1024, acceptNonZeroExit: true },
    { signal, retainCleanup: (owner) => cleanupOwners.add(owner) },
  );
}
export async function fileDigest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function treeFiles(root, prefix = "") {
  const result = [];
  for (const entry of (
    await readdir(join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Recovered output contains a symlink: ${name}`);
    if (entry.isDirectory()) result.push(...(await treeFiles(root, name)));
    else if (entry.isFile())
      result.push({ path: name, sha256: await fileDigest(join(root, name)) });
    else throw new Error(`Unsupported recovered output entry: ${name}`);
  }
  return result;
}

export function inspectRecoveredProject(xml) {
  const failures = [];
  const doc = new DOMParser({
    onError: (level, message) => failures.push(`${level}: ${message}`),
  }).parseFromString(xml, "application/xml");
  if (
    failures.length ||
    !doc.documentElement ||
    doc.documentElement.tagName !== "Project"
  )
    throw new Error("Invalid recovered project XML");
  if (
    !["Microsoft.NET.Sdk", "Microsoft.NET.Sdk.WindowsDesktop"].includes(
      doc.documentElement.getAttribute("Sdk"),
    )
  )
    throw new Error("Unsupported recovered SDK");
  const allowed = new Set([
    "Project",
    "PropertyGroup",
    "ItemGroup",
    "TargetFramework",
    "OutputType",
    "LangVersion",
    "AllowUnsafeBlocks",
    "CheckForOverflowUnderflow",
    "GenerateAssemblyInfo",
    "GenerateTargetFrameworkAttribute",
    "EnableDefaultItems",
    "UseWindowsForms",
    "UseWPF",
    "ApplicationIcon",
    "RootNamespace",
    "AssemblyName",
    "Reference",
    "EmbeddedResource",
    "Compile",
    "None",
    "LogicalName",
    "DependentUpon",
    "Nullable",
    "ImplicitUsings",
  ]);
  const unsafePath =
    /\$\(|@\(|%\(|(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|^[A-Za-z]:/;
  for (const element of Array.from(doc.getElementsByTagName("*"))) {
    if (!allowed.has(element.tagName))
      throw new Error(
        `Unsupported recovered project element: ${element.tagName}`,
      );
    for (const attribute of Array.from(element.attributes)) {
      if (element.tagName === "Project" && attribute.name === "Sdk") continue;
      if (
        !["Include", "Remove", "Update"].includes(attribute.name) ||
        unsafePath.test(attribute.value)
      )
        throw new Error(
          "Recovered project contains an external or evaluated item path",
        );
    }
    if (
      !Array.from(element.childNodes).some((node) => node.nodeType === 1) &&
      unsafePath.test(element.textContent.trim())
    )
      throw new Error(
        "Recovered project contains an external or evaluated property value",
      );
  }
  for (const name of [
    "Import",
    "Target",
    "UsingTask",
    "Exec",
    "ProjectReference",
    "PackageReference",
  ])
    if (doc.getElementsByTagName(name).length)
      throw new Error(`Unsupported recovered project capability: ${name}`);
  // This first route supports one assembly and framework references, not original-code delegation.
  if (doc.getElementsByTagName("HintPath").length)
    throw new Error(
      "External assembly references require a multi-assembly recovery plan; refusing to bind the original deployment",
    );
  if (doc.getElementsByTagName("RestoreSources").length)
    throw new Error("Recovered project must not select package sources");
  const nodes = doc.getElementsByTagName("TargetFramework");
  if (
    nodes.length !== 1 ||
    !/^net\d+\.\d+(?:-windows(?:\d+(?:\.\d+)*)?)?$/.test(
      nodes[0].textContent.trim(),
    )
  )
    throw new Error(
      "This recovery route requires a single modern .NET target framework",
    );
  const output = doc.getElementsByTagName("OutputType");
  if (
    output.length !== 1 ||
    !["Exe", "WinExe"].includes(output[0].textContent.trim())
  )
    throw new Error("Selected assembly is not an executable application");
  return {
    target_framework: nodes[0].textContent.trim(),
    output_type: output[0].textContent.trim(),
  };
}

export async function restoreManaged(input, state, inventory, signal) {
  const assembly = await realpath(input.assembly_path);
  const originalDigest = await fileDigest(assembly);
  if (
    !inventory.normalized_result.nodes.some(
      (node) => node.sha256 === originalDigest,
    )
  )
    throw new Error(
      "Selected assembly is not a component of the original project",
    );
  const output = resolve(input.output_directory);
  await assertOutsideTarget(output, state.target.path, true);
  for (const command of [input.ilspy_command, input.dotnet_command]) {
    if (!isAbsolute(command) || !(await lstat(command)).isFile())
      throw new Error("Supply an absolute, existing tool executable");
  }
  await mkdir(output, { mode: 0o700 });
  const snapshot = join(output, "input");
  const sources = join(output, "source");
  const rebuilt = join(output, "rebuilt");
  await mkdir(snapshot);
  const captured = join(snapshot, basename(assembly));
  await copyFile(assembly, captured);
  if ((await fileDigest(captured)) !== originalDigest)
    throw new Error("Assembly changed while snapshotting");
  const receipt = {
    schema_version: 1,
    status: "recovering",
    mode: "managed-single-assembly-project",
    original: { path: assembly, sha256: originalDigest },
    commands: [],
    tools: {
      ilspy: {
        path: input.ilspy_command,
        sha256: await fileDigest(input.ilspy_command),
      },
      dotnet: {
        path: input.dotnet_command,
        sha256: await fileDigest(input.dotnet_command),
      },
    },
    output_directory: output,
    sources_directory: sources,
    rebuilt_directory: rebuilt,
    behavior: "not-run",
    limitations: [
      "Rebuilt application is not yet behavior-verified.",
      "Single managed application assembly and embedded resources only; original source names/comments and all possible behaviors are not recovered.",
      "Native-only executables and external application assembly dependencies need separate reconstruction routes.",
    ],
  };
  const record = () =>
    writeFile(join(output, "recovery.json"), json(receipt), { mode: 0o600 });
  const run = async (step, command, args) => {
    let result;
    try {
      result = await owned(command, args, output, input.timeout_ms, signal);
    } catch (error) {
      const log = `${step}-failure.json`;
      const bytes = json({
        command,
        arguments: args,
        error: error.message,
        snapshot: error.snapshot ?? null,
        resources: error.resources ?? null,
      });
      await writeFile(join(output, log), bytes, { mode: 0o600 });
      receipt.commands.push({
        step,
        command,
        arguments: args,
        error: error.message,
        log,
        log_sha256: sha256(bytes),
      });
      throw error;
    }
    const log = `${step}.json`;
    const bytes = json({ command, arguments: args, result });
    await writeFile(join(output, log), bytes, { mode: 0o600 });
    receipt.commands.push({
      step,
      command,
      arguments: args,
      exit_code: result.exitCode,
      log,
      log_sha256: sha256(bytes),
    });
    await record();
    if (
      result.exitCode !== 0 ||
      result.diagnosticTruncated ||
      result.stdout.invalidUtf8 ||
      result.stderr.invalidUtf8
    )
      throw new Error(
        `${step} failed or output was incomplete. See ${join(output, log)}`,
      );
    return result.stdout.text;
  };
  try {
    const toolVersion = await run("ilspy-version", input.ilspy_command, [
      "--version",
    ]);
    if (!toolVersion.includes(ILSPY_VERSION))
      throw new Error(`Verified adapter requires ILSpy ${ILSPY_VERSION}`);
    receipt.tools.ilspy.version = toolVersion.trim();
    receipt.tools.dotnet.version = (
      await run("dotnet-version", input.dotnet_command, ["--version"])
    ).trim();
    await run("decompile", input.ilspy_command, [
      "--disable-updatecheck",
      "-p",
      "-o",
      sources,
      captured,
    ]);
    receipt.recovered_sources = await treeFiles(sources);
    const projects = receipt.recovered_sources.filter((file) =>
      file.path.endsWith(".csproj"),
    );
    if (projects.length !== 1)
      throw new Error("Expected exactly one reconstructed project");
    const projectFile = join(sources, projects[0].path);
    receipt.project = inspectRecoveredProject(
      await readFile(projectFile, "utf8"),
    );
    // Prevent ambient repo MSBuild/response-file customizations from affecting the recovered project.
    await run("build", input.dotnet_command, [
      "build",
      projectFile,
      "--configuration",
      "Release",
      "--output",
      rebuilt,
      "-p:ImportDirectoryBuildProps=false",
      "-p:ImportDirectoryBuildTargets=false",
      "-p:EnableWindowsTargeting=true",
      "-p:UseSharedCompilation=false",
      "-nodeReuse:false",
      "-noAutoResponse",
    ]);
    receipt.rebuilt_files = await treeFiles(rebuilt);
    if (!receipt.rebuilt_files.some((file) => file.path.endsWith(".dll")))
      throw new Error("Rebuild did not produce a managed assembly");
    if (
      (await fileDigest(assembly)) !== originalDigest ||
      (await fileDigest(captured)) !== originalDigest
    )
      throw new Error("Original bytes changed during recovery");
    for (const tool of Object.values(receipt.tools))
      if ((await fileDigest(tool.path)) !== tool.sha256)
        throw new Error("Tool executable changed during recovery");
    receipt.status = "rebuilt";
    await record();
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error.message;
    receipt.unresolved_cleanup_owners = cleanupOwners.size;
    await record();
    throw error;
  }
}
