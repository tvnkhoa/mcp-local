/**
 * MCP-ISSUE-108: a peer client in its own process, for test-http-transport.mjs. Refactor ownership is per
 * client process, so a peer must be another process. Reads { port, token, calls } from PEER_REQUEST, runs
 * the calls over one fresh session and prints their results as JSON.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { port, token, calls } = JSON.parse(process.env.PEER_REQUEST ?? "{}");
const client = new Client({ name: "r4-peer", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
);
const results = [];
for (const call of calls) results.push(await client.callTool(call));
await client.close();
process.stdout.write(JSON.stringify(results));
