#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { contracts, VERSION } from "./contracts.mjs";
import { execute } from "./service.mjs";

const [operation, argument] = process.argv.slice(2);
try {
  if (operation === "mcp") {
    const { serve } = await import("./mcp.mjs");
    await serve();
  } else if (operation === "--version") {
    console.log(VERSION);
  } else if (!operation || operation === "--help") {
    console.log(
      `Personal REA Workbench ${VERSION}\nUsage: rea-workbench <operation> '<JSON>' | @input.json\nOperations: ${Object.keys(contracts).join(", ")}\nMCP: rea-workbench mcp`,
    );
  } else {
    const input = argument?.startsWith("@")
      ? await readFile(argument.slice(1), "utf8")
      : argument;
    console.log(
      JSON.stringify(await execute(operation, JSON.parse(input)), null, 2),
    );
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
