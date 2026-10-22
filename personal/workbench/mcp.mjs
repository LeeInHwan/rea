import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { contracts, descriptions, VERSION } from "./contracts.mjs";
import { execute } from "./service.mjs";

export async function serve() {
  const server = new McpServer({
    name: "personal-rea-workbench",
    version: VERSION,
  });
  for (const [name, inputSchema] of Object.entries(contracts)) {
    server.registerTool(
      name,
      { description: descriptions[name], inputSchema },
      async (input, context) => {
        try {
          const result = await execute(name, input, {
            signal: context.mcpReq.signal,
          });
          return {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error.message }],
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
