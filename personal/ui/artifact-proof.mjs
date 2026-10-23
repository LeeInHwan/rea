#!/usr/bin/env node
// Opt-in real-provider proof. Supply existing APKTOOL_JAR, JAVA_COMMAND and APK_FIXTURE.
import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { runOperation, requestSchema } from "./operations.mjs";
import { owned, fileDigest } from "../workbench/managed-restore.mjs";
import { createPackage } from "@electron/asar";
const directory = resolve(process.argv[2]);
await mkdir(directory, { mode: 0o700 });
const outcomes = {};
const run = async (label, input) => {
  const job = join(directory, label);
  await mkdir(job);
  const value = await runOperation(
    requestSchema.parse(input),
    job,
    async (stage, status) =>
      process.stderr.write(`${label}: ${stage} ${status}\n`),
  );
  outcomes[label] = value;
  await writeFile(
    join(directory, "proof.json"),
    JSON.stringify(outcomes, null, 2),
  );
  return value;
};
const apk = await realpath(process.env.APK_FIXTURE);
const apkProject = join(directory, "apk-project");
await run("apk-inventory", {
  action: "analyze",
  project: apkProject,
  target: apk,
});
const rebuilt = await run("apk-rebuild", {
  action: "apk",
  project: apkProject,
  output: join(directory, "apk-restored"),
  java: process.env.JAVA_COMMAND,
  apktool: process.env.APKTOOL_JAR,
});
assert.equal(rebuilt.apk.status, "rebuilt-unsigned");
assert.equal(rebuilt.apk.behavior, "not-run");
assert.ok(rebuilt.apk.decoded_files.some((f) => f.path.endsWith(".smali")));
assert.ok(
  rebuilt.apk.decoded_files.some((f) => f.path === "AndroidManifest.xml"),
);
await run("apk-deep", {
  action: "deep",
  project: apkProject,
  route: "android",
});
if (process.platform === "darwin") {
  const source = join(directory, "native.c");
  const binary = join(directory, "probe");
  await writeFile(
    source,
    '#include <stdio.h>\nint main(void) { puts("REA native proof"); return 0; }\n',
  );
  const cc = await owned(
    "/usr/bin/cc",
    [source, "-o", binary],
    directory,
    120000,
  );
  assert.equal(cc.exitCode, 0);
  const project = join(directory, "native-project");
  await run("native-inventory", { action: "analyze", project, target: binary });
  await run("native-deep", { action: "deep", project, route: "native" });
  const contents = join(directory, "dmg-source");
  await mkdir(contents);
  const appContents = join(contents, "Probe.app", "Contents");
  await mkdir(join(appContents, "MacOS"), { recursive: true });
  await copyFile(binary, join(appContents, "MacOS", "probe"));
  await writeFile(
    join(appContents, "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>local.rea.probe</string></dict></plist>',
  );
  await writeFile(
    join(contents, "README.txt"),
    "Owned Personal REA extraction fixture\n",
  );
  const dmg = join(directory, "fixture.dmg");
  const disk = await owned(
    "/usr/bin/hdiutil",
    [
      "create",
      "-srcfolder",
      contents,
      "-volname",
      "REA-proof",
      "-format",
      "UDZO",
      dmg,
    ],
    directory,
    120000,
  );
  assert.equal(disk.exitCode, 0);
  const diskProject = join(directory, "dmg-project");
  await run("dmg-inventory", {
    action: "analyze",
    project: diskProject,
    target: dmg,
  });
  const extracted = await run("dmg-extract", {
    action: "extract",
    project: diskProject,
  });
  const recoveredBinary = extracted.extract.normalized_result.artifacts.find(
    (a) => a.relative_path.endsWith("Probe.app/Contents/MacOS/probe"),
  );
  assert.ok(recoveredBinary);
  assert.equal(
    await fileDigest(
      join(
        extracted.extract.normalized_result.output_root,
        recoveredBinary.relative_path,
      ),
    ),
    await fileDigest(binary),
  );
  assert.equal(
    await readFile(
      join(
        extracted.extract.normalized_result.output_root,
        extracted.extract.normalized_result.artifacts.find((a) =>
          a.relative_path.endsWith("README.txt"),
        ).relative_path,
      ),
      "utf8",
    ),
    "Owned Personal REA extraction fixture\n",
  );
}
const js = join(directory, "javascript");
await mkdir(js);
await writeFile(
  join(js, "package.json"),
  '{"name":"rea-proof","main":"index.js"}',
);
await writeFile(join(js, "index.js"), "module.exports = (a, b) => a + b;\n");
const asar = join(directory, "app.asar");
await createPackage(js, asar);
const jsProject = join(directory, "js-project");
await run("js-inventory", {
  action: "analyze",
  project: jsProject,
  target: asar,
});
const extracted = await run("js-extract", {
  action: "extract",
  project: jsProject,
});
assert.equal(
  await fileDigest(
    join(extracted.extract.normalized_result.output_root, "index.js"),
  ),
  await fileDigest(join(js, "index.js")),
);
await run("js-deep", {
  action: "deep",
  project: jsProject,
  route: "javascript",
});
console.log(`Real provider proof saved: ${join(directory, "proof.json")}`);
