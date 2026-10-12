import { withProcessCancellation } from "../ProcessCancellation.js";
import type { AnalysisClient, ExecutionOptions } from "../AnalysisProvider.js";
import {
  analysisExecutionCleanupFailure,
  withSessionCleanup,
} from "../DirectAnalysisCleanup.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { createEvidence } from "../../domain/evidence.js";
import { artifactInspectionResultSchema } from "../../domain/artifactInspection.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";

/** Inspect a caller-selected path without opening or rebinding a native session. */
export class ArtifactPathAnalysisService {
  constructor(
    private readonly createClient: (path: string) => AnalysisClient,
  ) {}

  inspect(
    path: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const client = this.createClient(path);
    return withProcessCancellation(options?.signal, (signal) =>
      withSessionCleanup(
        client,
        () =>
          client.execute("inspect_artifact", parameters, {
            ...options,
            signal,
          }),
        analysisExecutionCleanupFailure,
      ),
    );
  }

  /** Project the same provider observation for one-shot CLI delivery. */
  async inspectEvidence(
    path: string,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const result = await this.inspect(
      path,
      parameters,
      signal === undefined ? undefined : { signal },
    );
    if (!result.ok)
      return {
        error: "Analysis failed",
        ...projectAnalysisError(result.error),
      };
    const value = result.value;
    return createEvidence(value.subject ?? undefined, value.provider, {
      operation: "inspect_artifact",
      parameters,
      result: value.result,
      rawResult: value.rawResult,
      limitations: value.limitations,
      locations: value.locations,
      evidenceLinks: artifactInspectionResultSchema.parse(value.result)
        .evidence_links,
    });
  }
}
