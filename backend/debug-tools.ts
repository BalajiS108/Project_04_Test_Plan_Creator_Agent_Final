import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@playwright/mcp"],
});

const client = new Client(
    { name: "tool-debugger", version: "1.0.0" },
    { capabilities: {} }
);

await client.connect(transport);
const toolsResponse = await client.listTools();

// Show parameters for key tools
const tools = [
    "browser_navigate",
    "browser_click",
    "browser_fill_form",
    "browser_type",
    "browser_wait_for",
];

toolsResponse.tools
    .filter((t: any) => tools.includes(t.name))
    .forEach((tool: any) => {
        console.log(`\n${tool.name}:`);
        console.log(`  Description: ${tool.description}`);
        console.log(`  Parameters:`, JSON.stringify(tool.inputSchema, null, 2));
    });

await client.close();
