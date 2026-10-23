import test from "node:test";
import assert from "node:assert/strict";
import { inspectRecoveredProject } from "./managed-restore.mjs";
const project = (extra = "", sdk = "Microsoft.NET.Sdk") =>
  `<Project Sdk="${sdk}"><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><OutputType>WinExe</OutputType><UseWindowsForms>true</UseWindowsForms></PropertyGroup>${extra}</Project>`;
test("recovered project cannot delegate to original assemblies, external build tasks or escaping paths", () => {
  assert.equal(
    inspectRecoveredProject(project()).target_framework,
    "net8.0-windows",
  );
  for (const extra of [
    '<Import Project="external.targets"/>',
    '<Target Name="Execute"/>',
    '<ItemGroup><Reference Include="Original"><HintPath>original.dll</HintPath></Reference></ItemGroup>',
    '<ItemGroup><PackageReference Include="Original" Version="1.0"/></ItemGroup>',
    '<ItemGroup><Compile Include="../original.cs"/></ItemGroup>',
    '<ItemGroup><Compile Include="$(Original)/code.cs"/></ItemGroup>',
  ])
    assert.throws(() => inspectRecoveredProject(project(extra)));
  assert.throws(() => inspectRecoveredProject(project("", "External.Sdk")));
  assert.throws(() => inspectRecoveredProject("<broken>"));
});

test("SDK framework HintPath normalization retains application dependency rejection", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, symlink } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { normalizeFrameworkReferences } =
    await import("./managed-restore.mjs");
  const root = await mkdtemp(join(tmpdir(), "rea-framework-test-"));
  try {
    const runtime = join(root, "shared/Microsoft.NETCore.App/10.0.0");
    await mkdir(runtime, { recursive: true });
    const dotnet = join(root, "dotnet");
    await writeFile(dotnet, "tool");
    const framework = join(runtime, "System.Console.dll");
    await writeFile(framework, "framework");
    const path = join(root, "App.csproj");
    const xml = (hint) =>
      project(
        `<ItemGroup><Reference Include="System.Console"><HintPath>${hint}</HintPath></Reference></ItemGroup>`,
      );
    await writeFile(path, xml(framework));
    const normalized = await normalizeFrameworkReferences(path, dotnet);
    assert.equal(normalized.framework_references.length, 1);
    inspectRecoveredProject(await readFile(path, "utf8"));
    const external = join(root, "System.Console.dll");
    await writeFile(external, "application");
    await writeFile(path, xml(external));
    await normalizeFrameworkReferences(path, dotnet);
    const outside = await readFile(path, "utf8");
    assert.throws(() => inspectRecoveredProject(outside));
    await rm(framework);
    await symlink(external, framework);
    await writeFile(path, xml(framework));
    assert.equal(
      (await normalizeFrameworkReferences(path, dotnet)).framework_references
        .length,
      0,
    );
    const unsafe = await readFile(path, "utf8");
    assert.throws(() => inspectRecoveredProject(unsafe));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
