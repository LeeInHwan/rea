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
