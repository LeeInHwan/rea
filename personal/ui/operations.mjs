import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { execute } from "../workbench/service.mjs";
import { withEngine } from "../workbench/engine.mjs";
import { load, json } from "../workbench/store.mjs";
import { fileDigest } from "../workbench/managed-restore.mjs";

const path = z.string().min(1).refine(isAbsolute, "절대 경로를 선택하세요.");
const command = z.strictObject({
  executable: path,
  arguments: z.array(z.string()).max(100).default([]),
});
export function executionObservations(left, right) {
  const a = left.normalized_result,
    b = right.normalized_result;
  const raw = (value) => value.frames.map((frame) => frame.data).join("");
  return {
    original_output: raw(a),
    candidate_output: raw(b),
    output_equal: a.truncated || b.truncated ? null : raw(a) === raw(b),
    original_exit: a.exit,
    candidate_exit: b.exit,
    exit_equal: JSON.stringify(a.exit) === JSON.stringify(b.exit),
    scope:
      "수집된 출력 바이트와 종료 결과만 비교. 프레임 시각·분할·정착 시간은 이 요약에서 제외하며 원본 Evidence와 전체 비교에 보존합니다.",
  };
}
export const requestSchema = z
  .strictObject({
    action: z.enum([
      "analyze",
      "resume",
      "restore",
      "verify",
      "pipeline",
      "export",
    ]),
    target: path.optional(),
    project: path,
    assembly: path.optional(),
    output: path.optional(),
    ilspy: path.optional(),
    dotnet: path.optional(),
    original: command.optional(),
    candidate: command.optional(),
    cwd: path.optional(),
    timeout: z.number().int().min(1000).max(120000).default(15000),
    executeAcknowledged: z.boolean().default(false),
    destination: path.optional(),
  })
  .superRefine((input, ctx) => {
    const required = {
      analyze: ["target"],
      resume: [],
      export: ["destination"],
      restore: ["assembly", "output", "ilspy", "dotnet"],
      verify: ["original", "candidate", "cwd"],
      pipeline: [
        "target",
        "assembly",
        "output",
        "ilspy",
        "dotnet",
        "original",
        "candidate",
        "cwd",
      ],
    }[input.action];
    for (const key of required)
      if (!input[key])
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "필수 입력입니다.",
        });
  });
export async function runOperation(input, directory, progress, signal) {
  const result = {};
  const stage = async (name, fn) => {
    signal?.throwIfAborted();
    await progress(name, "running");
    let value;
    try {
      value = await fn();
    } catch (error) {
      await progress(name, "failed");
      throw error;
    }
    result[name] = value;
    await writeFile(join(directory, `${name}.json`), json(value), {
      mode: 0o600,
    });
    await progress(name, "complete", value);
    return value;
  };
  if (["analyze", "pipeline"].includes(input.action)) {
    if (!input.target) throw new Error("분석할 원본을 선택하세요.");
    await stage("analysis", () =>
      execute(
        "project_create",
        { project: input.project, target: input.target },
        { signal },
      ),
    );
  } else if (input.action !== "export") {
    await stage("resume", () =>
      execute("project_resume", { project: input.project }, { signal }),
    );
  }
  if (["restore", "pipeline"].includes(input.action)) {
    const recovery = await stage("recovery", () =>
      execute(
        "restore_managed_application",
        {
          project: input.project,
          assembly_path: input.assembly,
          output_directory: input.output,
          ilspy_command: input.ilspy,
          dotnet_command: input.dotnet,
          timeout_ms: 300000,
        },
        { signal },
      ),
    );
    result.rebuilt_directory = recovery.rebuilt_directory;
  }
  if (input.action === "verify" || input.action === "pipeline") {
    if (!input.executeAcknowledged)
      throw new Error(
        "실행 검증은 원본과 후보를 사용자 권한으로 실행합니다. 실행 확인이 필요합니다.",
      );
    if (process.platform === "win32")
      throw new Error(
        "현재 터미널 실행 비교는 macOS/Linux에서 지원합니다. Windows GUI 검증은 전용 CI에서 수행합니다.",
      );
    if (!input.original || !input.candidate || !input.cwd)
      throw new Error(
        "원본·후보 실행 파일, 인자와 공통 작업 폴더를 지정하세요.",
      );
    const { state, bundle } = await load(input.project);
    const inventory = bundle.records.find(
      (x) => x.evidence_id === state.target.inventory_evidence_id,
    );
    const originalPaths = [
      input.original.executable,
      ...input.original.arguments.filter(isAbsolute),
    ];
    let bound = false;
    for (const value of originalPaths) {
      try {
        const actual = await realpath(value);
        const rel = relative(state.target.path, actual);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const hash = await fileDigest(actual);
        if (inventory?.normalized_result.nodes.some((n) => n.sha256 === hash))
          bound = true;
      } catch {
        /* Non-file arguments cannot establish original identity. */
      }
    }
    if (!bound)
      throw new Error(
        "원본 실행 파일 또는 절대 경로 인자가 등록한 원본의 구성 파일과 일치해야 합니다.",
      );
    const evidenceDir = join(directory, "captures");
    await mkdir(evidenceDir);
    await stage("verification", async () => {
      const captured = await withEngine(
        evidenceDir,
        null,
        async (call) => {
          const scenario = (side) => ({
            ...side,
            working_directory: input.cwd,
            timeout_ms: input.timeout,
            finalization_ms: 500,
          });
          await progress("original", "running");
          const left = await call(
            "capture_process_scenario",
            scenario(input.original),
          );
          await writeFile(join(directory, "original.json"), json(left), {
            mode: 0o600,
          });
          await progress("original", "complete");
          signal?.throwIfAborted();
          await progress("candidate", "running");
          const right = await call(
            "capture_process_scenario",
            scenario(input.candidate),
          );
          await writeFile(join(directory, "candidate.json"), json(right), {
            mode: 0o600,
          });
          await progress("candidate", "complete");
          result.execution_observations = executionObservations(left, right);
          return call("compare_process_captures", { left, right });
        },
        signal,
      );
      return {
        ...captured.result,
        scope:
          "선택한 한 번의 터미널 실행 관찰 비교. GUI·네트워크·모든 입력의 동등성 증명이 아닙니다.",
        evidence_path: join(evidenceDir, "evidence.json"),
      };
    });
    // Never silently replace a finite comparison with a full application verdict.
    result.comparison_status = result.verification.normalized_result.status;
  }
  if (input.action === "export") {
    await stage("export", () =>
      execute(
        "project_export",
        { project: input.project, destination: input.destination },
        { signal },
      ),
    );
  }
  result.plan = await execute(
    "project_plan",
    { project: input.project },
    { signal },
  );
  const saved = await load(input.project);
  const inventory = saved.bundle.records.find(
    (record) => record.evidence_id === saved.state.target.inventory_evidence_id,
  );
  if (inventory) {
    const graph = inventory.normalized_result;
    const nodes = new Map(graph.nodes.map((node) => [node.artifact_id, node]));
    result.inventory = {
      evidence_id: inventory.evidence_id,
      coverage: graph.coverage,
      total: graph.occurrences.length,
      displayed: Math.min(200, graph.occurrences.length),
      entries: graph.occurrences.slice(0, 200).map((entry) => ({
        path: entry.logical_path,
        format: entry.artifact_format,
        kind: entry.artifact_kind,
        sha256: nodes.get(entry.artifact_id)?.sha256 ?? null,
        size: nodes.get(entry.artifact_id)?.size ?? null,
        hash_status: entry.hash_status,
      })),
      limitations: graph.limitations,
    };
  }
  return result;
}
