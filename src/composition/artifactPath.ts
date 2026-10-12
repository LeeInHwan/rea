import { ArtifactProvider } from "../artifacts/ArtifactProvider.js";
import { ArtifactPathAnalysisService } from "../application/artifacts/ArtifactPathAnalysisService.js";

/** Bind path-based inspection to the caller's environment and existing reader. */
export const createArtifactPathAnalysis = (
  environment: Readonly<NodeJS.ProcessEnv>,
) => {
  const provider = new ArtifactProvider(environment);
  return new ArtifactPathAnalysisService((path) =>
    provider.createPathClient(path),
  );
};
