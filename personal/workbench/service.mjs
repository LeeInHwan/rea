import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contracts, VERSION } from "./contracts.mjs";
import { createEvidence } from "../../dist/domain/evidence.js";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import { restoreManaged } from "./managed-restore.mjs";
import {
  withEngine,
  parseEvidence,
  parseEvidenceBundle,
  serializeEvidenceBundle,
} from "./engine.mjs";
import {
  load,
  save,
  locked,
  temporary,
  assertOutsideTarget,
  json,
  sha256,
} from "./store.mjs";

function inspection(value) {
  const evidence = parseEvidence(value);
  const inventory = evidence.normalized_result.substeps.find(
    (item) => item.operation === "inventory_artifact",
  )?.evidence;
  if (!inventory)
    throw new Error(
      "REA inspection contract changed: inventory Evidence missing",
    );
  return parseEvidence(inventory);
}
function assertOriginal(state, inventory) {
  const manifest = inventory.normalized_result.manifest;
  if (
    manifest.root_sha256 !== state.target.sha256 ||
    manifest.manifest_id !== state.target.manifest_id
  )
    throw new Error(
      "Original target changed. Create a new project for the new version; existing evidence is preserved.",
    );
}
const requireFeature = (state, id) => {
  if (!Object.hasOwn(state.features, id))
    throw new Error(`Unknown feature: ${id}`);
  return state.features[id];
};
function componentDigests(state, bundle) {
  const record = bundle.records.find(
    (item) => item.evidence_id === state.target.inventory_evidence_id,
  );
  if (!record) throw new Error("Original inventory missing from checkpoint");
  return new Set(record.normalized_result.nodes.map((node) => node.sha256));
}
function invalidate(state) {
  for (const feature of Object.values(state.features))
    feature.verification = null;
}
export function plan(state) {
  const cycles = [];
  const visited = new Set();
  const visit = (id, stack) => {
    if (stack.includes(id)) {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    if (visited.has(id) || !Object.hasOwn(state.features, id)) return;
    visited.add(id);
    for (const dependency of state.features[id].contract.depends_on)
      visit(dependency, [...stack, id]);
  };
  for (const id of Object.keys(state.features).sort()) visit(id, []);
  const cyclic = new Set(cycles.flat());
  const satisfied = (id, seen = new Set()) => {
    if (seen.has(id) || cyclic.has(id) || !Object.hasOwn(state.features, id))
      return false;
    const feature = state.features[id];
    return (
      feature.verification?.status === "pass" &&
      feature.contract.depends_on.every((dependency) =>
        satisfied(dependency, new Set([...seen, id])),
      )
    );
  };
  return {
    revision: state.revision,
    target: state.target,
    engine_version: state.engine_version,
    target_validation:
      "retained checkpoint; use project_resume to check current target",
    cycles,
    features: Object.values(state.features)
      .sort((a, b) => a.contract.id.localeCompare(b.contract.id))
      .map(({ contract, verification }) => {
        const missing = contract.depends_on.filter(
          (dependency) => !Object.hasOwn(state.features, dependency),
        );
        const blocked = contract.depends_on.filter(
          (dependency) => !satisfied(dependency),
        );
        return {
          id: contract.id,
          title: contract.title,
          status:
            cyclic.has(contract.id) || blocked.length
              ? "blocked"
              : satisfied(contract.id)
                ? "verified"
                : "ready",
          verification: verification?.status ?? "not-run",
          missing_dependencies: missing,
          blocked_by: blocked,
          claim_scope:
            contract.specification?.claims.map(({ kind, dimension }) => ({
              kind,
              dimension,
            })) ?? [],
        };
      }),
    limitations: [
      "Verified means only the declared finite claims passed on retained evidence. Structural comparison does not prove behavior or global equivalence.",
    ],
  };
}

export async function execute(operation, rawInput, { signal } = {}) {
  if (!Object.hasOwn(contracts, operation))
    throw new Error(`Unknown operation: ${operation}`);
  const input = contracts[operation].parse(rawInput);
  const project = resolve(input.project);
  if (operation === "project_create") {
    const paths = await assertOutsideTarget(project, input.target, true);
    // Exclusive create: never overwrite existing work, even an incomplete project.
    await mkdir(project, { mode: 0o700 });
    return locked(project, async () => {
      const captured = await temporary(project, (directory) =>
        withEngine(
          directory,
          null,
          async (call) =>
            inspection(
              await call("inspect_artifact", { input_path: paths.target }),
            ),
          signal,
        ),
      );
      const manifest = captured.result.normalized_result.manifest;
      const now = new Date().toISOString();
      const state = {
        schema_version: 1,
        workbench_version: VERSION,
        engine_version: captured.engine_version,
        revision: 1,
        created_at: now,
        updated_at: now,
        target: {
          path: paths.target,
          sha256: manifest.root_sha256,
          manifest_id: manifest.manifest_id,
          inventory_evidence_id: captured.result.evidence_id,
        },
        features: {},
      };
      await save(project, state, captured.bundle);
      return plan(state);
    });
  }
  return locked(project, async () => {
    const snapshot = await load(project);
    const state = snapshot.state;
    let bundle = snapshot.bundle;
    if (operation === "project_plan") return plan(state);
    if (operation === "restore_managed_application") {
      const captured = await temporary(project, (directory) =>
        withEngine(
          directory,
          bundle,
          async (call) => {
            assertOriginal(
              state,
              inspection(
                await call("inspect_artifact", {
                  input_path: state.target.path,
                }),
              ),
            );
            const managed = parseEvidence(
              await call("inspect_managed_artifact", {
                path: resolve(input.assembly_path),
              }),
            );
            const inventory = bundle.records.find(
              (item) => item.evidence_id === state.target.inventory_evidence_id,
            );
            const result = await restoreManaged(
              input,
              state,
              inventory,
              signal,
            );
            const evidence = createEvidence(
              {
                path: managed.subject.local_path,
                sha256: managed.subject.digest.sha256,
                format: managed.subject.format,
              },
              {
                id: "personal-rea-workbench",
                name: "Personal REA managed restoration",
                version: VERSION,
              },
              {
                predicateType: "personal-rea.managed-restore",
                operation,
                parameters: input,
                result,
                confidence: "observed",
                authority: "controlled-replay",
                evidenceLinks: [managed.evidence_id],
                limitations: result.limitations,
              },
            );
            return { result, evidence };
          },
          signal,
        ),
      );
      bundle = createEvidenceBundle(
        [...captured.bundle.records, captured.result.evidence],
        captured.bundle.unknowns,
      );
      state.revision += 1;
      state.updated_at = new Date().toISOString();
      state.engine_version = captured.engine_version;
      state.workbench_version = VERSION;
      await save(project, state, bundle);
      return {
        status: "rebuilt",
        behavior: "not-run",
        output_directory: captured.result.result.output_directory,
        evidence_id: captured.result.evidence.evidence_id,
        source_files: captured.result.result.recovered_sources.length,
        output_files: captured.result.result.rebuilt_files.length,
        limitations: captured.result.result.limitations,
      };
    }
    if (operation === "project_export") {
      const destination = resolve(input.destination);
      await assertOutsideTarget(destination, state.target.path, true);
      await mkdir(destination, { mode: 0o700 });
      await assertOutsideTarget(destination, state.target.path);
      const files = {
        "project.json": json(state),
        "evidence.json": serializeEvidenceBundle(bundle),
        "plan.json": json(plan(state)),
      };
      for (const [name, bytes] of Object.entries(files))
        await writeFile(join(destination, name), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      await writeFile(
        join(destination, "manifest.json"),
        json({
          format: "personal-rea-contract-package-v1",
          revision: snapshot.head,
          authenticity: "unsigned-local-record",
          files: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
          ),
          limitations: [
            "Evidence and contracts only; no executable implementation or original binaries included.",
            "Evidence retains original paths and output. Review before sharing.",
          ],
        }),
        { flag: "wx", mode: 0o600 },
      );
      return {
        destination,
        revision: snapshot.head,
        kind: "contract-and-evidence",
        complete: true,
      };
    }
    if (operation === "feature_define") {
      if (!componentDigests(state, bundle).has(input.feature.original_sha256))
        throw new Error(
          "Feature digest is not a component of the original inventory",
        );
      if (
        new Set(input.feature.depends_on).size !==
        input.feature.depends_on.length
      )
        throw new Error("Duplicate dependencies");
      // Changing a contract may invalidate every dependent acceptance decision.
      invalidate(state);
      Object.defineProperty(state.features, input.feature.id, {
        value: { contract: input.feature, verification: null },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      const captured = await temporary(project, (directory) =>
        withEngine(
          directory,
          bundle,
          async (call) => {
            if (operation === "project_checkpoint") {
              const imported = parseEvidenceBundle(
                JSON.parse(await readFile(resolve(input.bundle_path), "utf8")),
              );
              const source = join(directory, "incoming.json");
              await writeFile(source, serializeEvidenceBundle(imported), {
                mode: 0o600,
              });
              await call("import_evidence_bundle", { path: source });
              invalidate(state);
              return;
            }
            const originalEvidence = parseEvidence(
              await call("inspect_artifact", { input_path: state.target.path }),
            );
            const original = inspection(originalEvidence);
            assertOriginal(state, original);
            if (operation === "project_resume") return;
            const feature = requireFeature(state, input.feature_id);
            if (operation === "artifact_compare") {
              if (feature.contract.original_sha256 !== state.target.sha256)
                throw new Error(
                  "artifact_compare compares project roots; use core REA for component/function/behavioral comparisons and checkpoint them",
                );
              const candidate = parseEvidence(
                await call("inspect_artifact", {
                  input_path: resolve(input.candidate_path),
                }),
              );
              const comparison = parseEvidence(
                await call("compare_artifacts", {
                  left: originalEvidence,
                  right: candidate,
                }),
              );
              invalidate(state);
              feature.contract.specification = {
                name: feature.contract.title,
                claims: [
                  {
                    claim_id: "artifact",
                    title: feature.contract.title,
                    kind: "structural-artifact",
                    dimension: "overall",
                    comparison_evidence_id: comparison.evidence_id,
                  },
                ],
              };
              return;
            }
            if (!feature.contract.specification)
              throw new Error(
                "Define finite comparison claims before verification",
              );
            return parseEvidence(
              await call("verify_reconstruction", {
                specification: feature.contract.specification,
              }),
            );
          },
          signal,
        ),
      );
      bundle = captured.bundle;
      state.engine_version = captured.engine_version;
      if (operation === "feature_verify") {
        const feature = requireFeature(state, input.feature_id);
        const verification = captured.result.normalized_result;
        const byId = new Map(
          bundle.records.map((record) => [record.evidence_id, record]),
        );
        // Bind each original-side source directly. Do not infer identity from arbitrary graph links.
        const unbound = verification.claims.items
          .filter(
            (claim) =>
              !claim.left_evidence_ids.every((id) => {
                const source = byId.get(id);
                return (
                  source?.subject?.digest.sha256 ===
                  feature.contract.original_sha256
                );
              }),
          )
          .map((claim) => claim.claim_id);
        feature.verification = {
          engine_result: verification,
          status: unbound.length ? "unknown" : verification.status,
          verification_evidence_id: captured.result.evidence_id,
          original_binding: {
            sha256: feature.contract.original_sha256,
            unbound_claims: unbound,
          },
          limitations: [
            ...verification.limitations,
            ...(unbound.length
              ? [
                  "Original-side sources do not directly identify the selected component; binding remains unknown.",
                ]
              : []),
          ],
        };
      }
    }
    state.revision += 1;
    state.updated_at = new Date().toISOString();
    await save(project, state, bundle);
    return plan(state);
  });
}
