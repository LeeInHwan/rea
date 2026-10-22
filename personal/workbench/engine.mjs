import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import {
  parseEvidenceBundle,
  serializeEvidenceBundle,
} from "../../dist/domain/evidenceBundle.js";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { readFile, writeFile } from "node:fs/promises";
import { VERSION } from "./contracts.mjs";

export { parseEvidenceBundle, serializeEvidenceBundle, parseEvidence };
export async function withEngine(directory, bundle, action, signal) {
  const client = new Client({
    name: "personal-rea-workbench",
    version: VERSION,
  });
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "JAVA_HOME",
      "GHIDRA_INSTALL_DIR",
      "REA_JADX_MCP_JAR",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
      "mcp",
    ],
    env,
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const call = async (name, args) => {
      const response = await client.callTool(
        { name, arguments: args },
        { timeout: 450_000, signal },
      );
      if (response.isError)
        throw new Error(`REA ${name}: ${JSON.stringify(response.content)}`);
      const value =
        response.structuredContent ??
        JSON.parse(response.content.find((part) => part.type === "text").text);
      return value;
    };
    if (bundle) {
      await writeFile(
        `${directory}/restore.json`,
        serializeEvidenceBundle(bundle),
        { mode: 0o600 },
      );
      await call("import_evidence_bundle", {
        path: `${directory}/restore.json`,
      });
    }
    const result = await action(call);
    await call("export_evidence_bundle", {
      path: `${directory}/evidence.json`,
    });
    const saved = parseEvidenceBundle(
      JSON.parse(await readFile(`${directory}/evidence.json`, "utf8")),
    );
    return {
      result,
      bundle: saved,
      engine_version: client.getServerVersion()?.version ?? "unknown",
    };
  } finally {
    await client.close();
  }
}
