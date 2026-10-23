import { mkdir, writeFile, copyFile, stat, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { withEngine } from "../workbench/engine.mjs";
import { load, assertOutsideTarget, json } from "../workbench/store.mjs";
import { fileDigest, treeFiles, owned } from "../workbench/managed-restore.mjs";

export const APKTOOL_VERSION = "3.0.3";
export const APKTOOL_SHA256 =
  "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423";

export async function selectedArtifact(project, selected) {
  const { state, bundle } = await load(project);
  const path = await realpath(selected || state.target.path);
  const root = await realpath(state.target.path);
  const inventory = bundle.records.find(
    (r) => r.evidence_id === state.target.inventory_evidence_id,
  );
  if (path === root) {
    if (
      (await stat(path)).isFile() &&
      (await fileDigest(path)) !== state.target.sha256
    )
      throw new Error("원본 파일이 프로젝트 등록 이후 변경되었습니다.");
    return { path, state, inventory };
  }
  const rel = relative(root, path);
  if (
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel)
  )
    throw new Error(
      "등록한 원본 내부 파일을 선택하세요. 추출 결과는 새 프로젝트로 등록하세요.",
    );
  const entry = inventory.normalized_result.occurrences.find(
    (o) => o.logical_path === rel.split("\\").join("/"),
  );
  const node = inventory.normalized_result.nodes.find(
    (n) => n.artifact_id === entry?.artifact_id,
  );
  if (!node?.sha256 || node.sha256 !== (await fileDigest(path)))
    throw new Error(
      "선택한 파일의 경로·해시가 원본 인벤토리와 일치하지 않습니다.",
    );
  return { path, state, inventory };
}

export async function analyzeArtifact(input, directory, signal) {
  const selected = await selectedArtifact(input.project, input.assembly);
  const evidenceDir = join(directory, "artifact-evidence");
  await mkdir(evidenceDir);
  const captured = await withEngine(
    evidenceDir,
    null,
    async (call) => {
      if (input.route === "android")
        return call("inspect_android_package", {
          path: selected.path,
          detail: "summary",
        });
      if (input.route === "javascript")
        return call("analyze_javascript_application", {
          input_path: selected.path,
          detail: "summary",
        });
      await call("open_binary", {
        path: selected.path,
        ...(input.route === "native" ? { provider_id: "ghidra" } : {}),
      });
      try {
        return input.action === "extract"
          ? await call("extract_artifact", {})
          : await call("binary_overview", {});
      } finally {
        await call("close_binary", {});
      }
    },
    signal,
  );
  return {
    ...captured.result,
    evidence_path: join(evidenceDir, "evidence.json"),
    scope:
      input.action === "extract"
        ? "배포된 일반 파일의 추출입니다. 원본 소스 프로젝트 복원·재빌드·실행 검증은 별도입니다."
        : "정적 분석입니다. 대상 앱을 실행하거나 전체 소스를 재생성하지 않습니다.",
  };
}

export async function rebuildApk(input, directory, signal) {
  const { path, state, inventory } = await selectedArtifact(input.project);
  if (inventory.normalized_result.manifest.root_format !== "apk")
    throw new Error("APK 파일 자체를 원본으로 등록한 프로젝트가 필요합니다.");
  const java = await realpath(input.java);
  const jar = await realpath(input.apktool);
  if ((await fileDigest(jar)) !== APKTOOL_SHA256)
    throw new Error(
      "공식 Apktool 3.0.3 JAR의 고정 SHA-256과 일치하지 않습니다.",
    );
  const { project: output } = await assertOutsideTarget(
    input.output,
    path,
    true,
  );
  await mkdir(output, { mode: 0o700 });
  const receipt = {
    schema_version: 1,
    status: "running",
    original: { path, sha256: state.target.sha256 },
    tool: {
      version: APKTOOL_VERSION,
      jar,
      sha256: APKTOOL_SHA256,
      java,
      java_sha256: await fileDigest(java),
    },
    commands: [],
    behavior: "not-run",
    signing: "unsigned",
    limitations: [
      "Smali와 리소스 재빌드이며 원본 Java/Kotlin·Gradle 프로젝트 복원이 아닙니다.",
      "서명·설치·기기 실행·원본 동작 동등성은 검증하지 않았습니다.",
      "네이티브 .so는 배포된 바이너리로 보존되며 C/C++ 소스로 복원되지 않습니다.",
    ],
  };
  const receiptPath = join(output, "receipt.json");
  const run = async (name, args) => {
    signal?.throwIfAborted();
    let result;
    try {
      result = await owned(
        java,
        ["-Xmx1024m", "-jar", jar, ...args],
        output,
        300000,
        signal,
      );
    } catch (error) {
      receipt.commands.push({
        name,
        arguments: args,
        error: error.message,
        snapshot: error.snapshot ?? null,
        resources: error.resources ?? null,
      });
      throw error;
    }
    receipt.commands.push({ name, arguments: args, ...result });
    await writeFile(receiptPath, json(receipt), { mode: 0o600 });
    if (
      result.exitCode !== 0 ||
      result.diagnosticTruncated ||
      result.stdout.invalidUtf8 ||
      result.stderr.invalidUtf8
    )
      throw new Error(`Apktool ${name} 실패. 로그: ${receiptPath}`);
    return result;
  };
  try {
    const snapshot = join(output, "original.apk");
    await copyFile(path, snapshot);
    if ((await fileDigest(snapshot)) !== state.target.sha256)
      throw new Error("APK가 분석 이후 변경되었습니다.");
    const version = await run("version", ["--version"]);
    if (!version.stdout.text.trim().split(/\s/).includes(APKTOOL_VERSION))
      throw new Error("Apktool 버전 불일치");
    const framework = join(output, "framework");
    await mkdir(framework);
    const decoded = join(output, "decoded");
    await run("decode", ["d", snapshot, "-o", decoded, "-p", framework]);
    receipt.decoded_files = await treeFiles(decoded);
    const rebuilt = join(output, "rebuilt-unsigned.apk");
    await run("build", ["b", decoded, "-o", rebuilt, "-p", framework]);
    if (!(await stat(rebuilt)).size) throw new Error("빈 APK 출력");
    const evidenceDir = join(directory, "rebuilt-evidence");
    await mkdir(evidenceDir);
    const captured = await withEngine(
      evidenceDir,
      null,
      (call) =>
        call("inspect_artifact", { input_path: rebuilt, detail: "summary" }),
      signal,
    );
    receipt.rebuilt = {
      path: rebuilt,
      sha256: await fileDigest(rebuilt),
      evidence_path: join(evidenceDir, "evidence.json"),
      inspection: captured.result,
    };
    receipt.status = "rebuilt-unsigned";
    return { ...receipt, output_directory: output, receipt_path: receiptPath };
  } catch (error) {
    receipt.status = signal?.aborted ? "cancelled" : "failed";
    receipt.error = error.message;
    throw error;
  } finally {
    await writeFile(receiptPath, json(receipt), { mode: 0o600 });
  }
}
