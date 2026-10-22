import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { createArtifactBinarySession } from "../../../../src/composition/binary.js";
import { thinMach } from "../../../../src/domain/binaryTarget.fixture.js";
import { interfaceBuilderAnalysisSchema } from "../../../../src/domain/apple/interfaceBuilderGraph.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { nativeAotPeFixture } from "../../../fixtures/nativeaotPe.js";

const { runProviderAnalysis } = createDirectAnalysis({});

it("runs static .app decoding without registering native analysis engines", async () => {
  const root = await createTestTempDirectory("rea-artifact-only-direct-");
  const app = join(root, "Fixture.app");
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>",
  );
  await writeFile(
    join(contents, "MacOS", "Fixture"),
    thinMach(0xfeedfacf, 0x0100000c),
  );

  const staticSession = await createArtifactBinarySession({
    REA_ANALYSIS_PROVIDER: "auto",
  });
  expect(await staticSession.status()).toMatchObject({
    analysis_provider_candidates: [],
  });
  await staticSession.close();

  const evidence = parseEvidence(
    await createDirectAnalysis({
      REA_ANALYSIS_PROVIDER: "auto",
    }).runProviderAnalysis(app, "decode_interface_builder", {}),
  );
  expect(evidence.operation).toBe("decode_interface_builder");
  expect(evidence.provider.id).toBe("rea-artifact-graph");
  const result = interfaceBuilderAnalysisSchema.parse(
    evidence.normalized_result,
  );
  expect(result.documents).toEqual([]);
  expect(result.graph.target_sha256).toBe(evidence.subject?.digest.sha256);
});

it("inspects an artifact through the direct CLI workflow without an REA grant", async () => {
  const root = await createTestTempDirectory("rea-artifact-direct-");
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  await mkdir(source);
  await writeFile(join(source, "main.js"), "console.log('ok');\n");
  await createPackageWithOptions(source, archive, {});

  const evidence = parseEvidence(
    await runProviderAnalysis(archive, "inspect_artifact", {}),
  );
  expect(evidence.operation).toBe("inspect_artifact");
  expect(evidence.provider.id).toBe("rea-artifact-graph");
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(inspection.subject.root_format).toBe("asar");
  expect(inspection.substeps[0]?.evidence.normalized_result).toMatchObject({
    occurrences: expect.arrayContaining([
      expect.objectContaining({ logical_path: "main.js" }),
    ]),
  });
});

const inspect = async (path: string) => {
  const evidence = parseEvidence(
    await runProviderAnalysis(path, "inspect_artifact", {}),
  );
  return artifactInspectionResultSchema.parse(evidence.normalized_result);
};

it("routes a mixed installed app by observed contents and deduplicates native probes", async () => {
  const root = await createTestTempDirectory("rea-installed-app-probes-");
  const app = join(root, "설치된 앱.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
  await writeFile(join(app, "Contents", "MacOS", "Main"), machO);
  await writeFile(join(app, "Contents", "MacOS", "Helper"), machO);
  await writeFile(join(app, "library.dll"), nativeAotPeFixture());
  await writeFile(join(app, "main.js"), "console.log('static only');");

  const inspection = await inspect(app);
  const operations = inspection.next_probes.map((probe) => probe.operation);
  expect(operations).toEqual([
    "analyze_javascript_application",
    "inspect_managed_artifact",
    "open_binary",
  ]);
  expect(
    inspection.next_probes.every((probe) =>
      probe.rationale.includes("retained inventory"),
    ),
  ).toBe(true);
  expect(inspection.unexplored_branches).toHaveLength(operations.length);
  expect(inspection.coverage.next_probes_retained).toBe(operations.length);
});

it("does not invent JavaScript or native targets from an empty folder, suffix, or symlink", async () => {
  const root = await createTestTempDirectory("rea-unknown-installation-");
  const app = join(root, "Installed Program");
  await mkdir(app);
  await writeFile(join(app, "fake.exe"), "not executable bytes");
  await writeFile(join(root, "external.js"), "console.log('outside');");
  await symlink(join(root, "external.js"), join(app, "linked.js"));
  expect((await inspect(app)).next_probes).toEqual([]);
});

it("routes APK inspection to JADX and extracted native libraries to a native provider", async () => {
  const root = await createTestTempDirectory("rea-apk-probes-");
  const archive = join(root, "Example.apk");
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add("AndroidManifest.xml", new TextReader("manifest fixture"));
  await zip.add(
    "lib/arm64-v8a/libfixture.so",
    new Uint8ArrayReader(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
  );
  await writeFile(archive, await zip.close());
  const inspection = await inspect(archive);
  expect(inspection.next_probes.map((probe) => probe.operation)).toEqual([
    "extract_artifact",
    "inspect_android_package",
    "open_binary",
  ]);
  expect(inspection.next_probes[1]?.rationale).toContain("full JDK");
  expect(inspection.next_probes[2]?.rationale).toContain(
    "Extract the container",
  );
});

it("suggests direct APK inspection without extracting an APK that has no native targets", async () => {
  const root = await createTestTempDirectory("rea-apk-only-probes-");
  const archive = join(root, "Example.apk");
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add("AndroidManifest.xml", new TextReader("manifest fixture"));
  await writeFile(archive, await zip.close());
  expect(
    (await inspect(archive)).next_probes.map((probe) => probe.operation),
  ).toEqual(["inspect_android_package"]);
});
