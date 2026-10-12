import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
} from "../contracts/artifactToolContracts.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { ok } from "../domain/result.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Logger } from "pino";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import type { ArtifactPathAnalysisService } from "../application/artifacts/ArtifactPathAnalysisService.js";

/** Register deterministic artifact inventory and safe extraction operations. */
export const registerArtifactTools = (
  server: EvidenceMcpServer,
  options: {
    readonly pathAnalysis: ArtifactPathAnalysisService;
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly evidenceById?: EvidenceLookup | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void => {
  registerEvidenceTools(server, ARTIFACT_TOOL_CONTRACTS, {
    ...options,
    analysisForAdmission: (analysis) => ({
      execute: (operation, parameters, executionOptions) => {
        if (
          operation === "inspect_artifact" &&
          typeof parameters.input_path === "string"
        ) {
          const { input_path, ...inventoryParameters } = parameters;
          return options.pathAnalysis.inspect(
            input_path,
            inventoryParameters,
            executionOptions,
          );
        }
        return analysis.execute(operation, parameters, executionOptions);
      },
    }),
    parametersForExecution: (operation, parameters) => {
      if (operation === "inspect_artifact") {
        const {
          detail: _detail,
          input_path,
          ...execution
        } = artifactInspectionInputSchema.parse(parameters);
        return {
          ...execution,
          ...(input_path === undefined ? {} : { input_path }),
        };
      }
      return operation === "extract_artifact"
        ? { ...parameters, output_root: createArtifactExtractionDestination() }
        : parameters;
    },
    projectEvidence: (operation, parameters, evidence) =>
      operation === "inspect_artifact" && parameters.detail === "summary"
        ? summarizeRetainedAnalysis(evidence, {
            recordEvidence: options.recordEvidence,
            evidenceById: options.evidenceById,
          })
        : ok(evidence),
    sourceEvidence: (operation, result) =>
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(result)
            .substeps.map(({ evidence }) => evidence)
        : [],
  });
};
