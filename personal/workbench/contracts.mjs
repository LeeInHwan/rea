import { z } from "zod";
import { reconstructionSpecificationSchema } from "../../dist/domain/reconstructionVerificationSchemas.js";

export const VERSION = "0.1.0";
const path = z.string().min(1);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const featureSchema = z.strictObject({
  id,
  title: z.string().min(1),
  description: z.string().min(1),
  original_sha256: digest,
  depends_on: z.array(id).default([]),
  specification: reconstructionSpecificationSchema.optional(),
});
export const contracts = {
  project_create: z.strictObject({ project: path, target: path }),
  project_resume: z.strictObject({ project: path }),
  project_checkpoint: z.strictObject({ project: path, bundle_path: path }),
  feature_define: z.strictObject({ project: path, feature: featureSchema }),
  feature_verify: z.strictObject({ project: path, feature_id: id }),
  artifact_compare: z.strictObject({
    project: path,
    feature_id: id,
    candidate_path: path,
  }),
  project_plan: z.strictObject({ project: path }),
  project_export: z.strictObject({ project: path, destination: path }),
};
export const descriptions = {
  project_create:
    "Create a persistent REA project outside the target. Inspect the shipped artifact without executing it; pin its inventory and digest.",
  project_resume:
    "Reinspect the original target, reject changed bytes or inventory, and restore the canonical evidence checkpoint. Does not resume a live debugger or process.",
  project_checkpoint:
    "Import a canonical REA evidence bundle exported by the core REA MCP. Validate provenance and save a new immutable revision. Does not execute bundle content.",
  feature_define:
    "Define a feature contract bound to a component digest from the original inventory, dependencies, and optional finite REA comparison claims. Editing invalidates prior verification.",
  feature_verify:
    "Evaluate declared claims using core REA verification. Require original-side evidence to match the selected original component; unbound claims remain unknown. Pass is finite, not global equivalence.",
  artifact_compare:
    "Compare the project root inventory with a candidate path, retain both, and set this feature's structural-artifact claim. This is NOT a behavioral verification.",
  project_plan:
    "Return compact ready, blocked, verified, missing-dependency and cycle diagnostics. Uses retained evidence; does not claim the target is currently unchanged.",
  project_export:
    "Export an immutable contract/evidence package into a new directory. Includes hashes, verification limitations and history snapshot; not original binary bytes or reconstructed source.",
};

export const stateSchema = z.strictObject({
  schema_version: z.literal(1),
  workbench_version: z.string(),
  engine_version: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  target: z.strictObject({
    path,
    sha256: digest,
    manifest_id: z.string(),
    inventory_evidence_id: z.string(),
  }),
  features: z.record(
    id,
    z.strictObject({
      contract: featureSchema,
      verification: z.unknown().nullable(),
    }),
  ),
});
