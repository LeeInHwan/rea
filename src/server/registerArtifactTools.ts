import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
} from "../contracts/artifactToolContracts.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import type { ArtifactPathAnalysisService } from "../application/artifacts/ArtifactPathAnalysisService.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

/** Operations whose MCP delivery may be a retained summary view. */
const SUMMARY_DELIVERY: ReadonlySet<string> = new Set([
  "inspect_artifact",
  "decode_interface_builder",
]);
/** inspect_artifact keeps an explicit detail in its Evidence parameters. */
const decodeWithoutDelivery = withoutDeliveryDetail(
  new Set(["decode_interface_builder"]),
);

/** Register deterministic artifact inventory and safe extraction operations. */
export const registerArtifactTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions & {
    readonly pathAnalysis: ArtifactPathAnalysisService;
  },
): void => {
  registerEvidenceTools(server, ARTIFACT_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
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
        : decodeWithoutDelivery(operation, parameters);
    },
    parametersForEvidence: decodeWithoutDelivery,
    sourceEvidence: (operation, result) =>
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(result)
            .substeps.map(({ evidence }) => evidence)
        : [],
  });
};
