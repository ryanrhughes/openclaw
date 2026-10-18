import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "./test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const CONNECT_PROMPT = "requester-oauth-connect-proof";
const WHOAMI_PROMPT = "requester-oauth-whoami-proof";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Generic OAuth-protected MCP service: every access token names the account that approved it. */
async function startOAuthMcpService() {
  let issuer = "";
  const challenges = new Map<string, string>();
  const accountsByToken = new Map<string, string>();
  let approvingAccount = "";
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
      sendJson(response, { ...metadata, client_id: "fixture-client" }, 201);
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (!redirectUri || !state || !challenge || !approvingAccount) {
        sendJson(response, { error: "invalid_request" }, 400);
        return;
      }
      const code = `code-${randomUUID()}`;
      challenges.set(code, `${challenge}\n${approvingAccount}`);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { Location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const [challenge, account] = (challenges.get(form.get("code") ?? "") ?? "").split("\n");
      const verifier = form.get("code_verifier") ?? "";
      if (!account || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        sendJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      challenges.delete(form.get("code") ?? "");
      const accessToken = `access-${randomUUID()}`;
      accountsByToken.set(accessToken, account);
      sendJson(response, { access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const account = accountsByToken.get(
        (request.headers.authorization ?? "").replace(/^Bearer /u, ""),
      );
      const body = await readBody(request);
      if (!account) {
        response.writeHead(401, {
          "Content-Type": "text/plain",
          "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
        });
        response.end("sign in required");
        return;
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === "initialize") {
        sendJson(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method?.startsWith("notifications/")) {
        response.writeHead(202, { "Content-Length": "0" }).end();
        return;
      }
      if (message.method === "tools/list") {
        sendJson(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "whoami",
                description: "Name the connected account.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        sendJson(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: `account:${account}` }], isError: false },
        });
        return;
      }
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("OAuth MCP fixture failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth MCP fixture did not bind a TCP address");
  }
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    url: `${issuer}/mcp`,
    approveAs: (account: string) => {
      approvingAccount = account;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type ModelBody = {
  input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
};

function respondWithText(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", item: message },
    {
      type: "response.completed",
      response: { id: `resp_${randomUUID()}`, status: "completed", usage: { total_tokens: 2 } },
    },
  ]);
}

function respondWithToolCall(
  response: ServerResponse,
  call: { kind: "search" | "invoke"; name: string; args: Record<string, unknown> },
): void {
  const id = randomUUID();
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${call.kind}_${id}`,
    name: call.name,
    arguments: JSON.stringify(call.args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { total_tokens: 2 },
      },
    },
  ]);
}

/** Finds the turn's MCP tool through tool search, calls it once, then reports its result. */
async function startModel() {
  const searchResults: string[] = [];
  const toolResults: string[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const raw = await readBody(request);
    const last = (JSON.parse(raw) as ModelBody).input?.at(-1);
    const output =
      typeof last?.output === "string" ? last.output : JSON.stringify(last?.output ?? null);
    const wanted = raw.includes(WHOAMI_PROMPT) ? "docs__whoami" : "docs__connect";
    if (last?.type === "function_call_output" && last.call_id?.startsWith("call_invoke_")) {
      toolResults.push(output);
      respondWithText(response, "tool-result-received");
      return;
    }
    if (last?.type === "function_call_output" && last.call_id?.startsWith("call_search_")) {
      searchResults.push(output);
      if (output.includes(wanted)) {
        respondWithToolCall(response, { kind: "invoke", name: "tool_call", args: { id: wanted } });
        return;
      }
      respondWithText(response, `missing ${wanted}`);
      return;
    }
    respondWithToolCall(response, {
      kind: "search",
      name: "tool_search",
      args: { query: "docs account" },
    });
  };
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void handle(request, response).catch((error: unknown) =>
          response.writeHead(500).end(String(error)),
        );
      }),
  });
  return { reservation, searchResults, toolResults };
}

it(
  "connects an authenticated Control UI requester's own account through the Gateway callback",
  { timeout: 120_000 },
  async () => {
    await withOpenClawTestState(
      {
        label: "mcp-requester-oauth-control-ui",
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        let model: Awaited<ReturnType<typeof startModel>> | undefined;
        let service: Awaited<ReturnType<typeof startOAuthMcpService>> | undefined;
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        await runQaGatewayFixture(
          async () => {
            model = await startModel();
            service = await startOAuthMcpService();
            const portClaim = await acquireGatewayE2ePortBlock();
            const provider = buildMockOpenAiResponsesProvider(
              `http://127.0.0.1:${model.reservation.claim.port}/v1`,
              "requester-oauth-proof",
            );
            const token = "synthetic-requester-oauth-token";
            const cfg = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              gateway: {
                auth: { mode: "token", token },
                controlUi: { allowedOrigins: ["http://localhost"] },
                publicOrigin: `http://127.0.0.1:${portClaim.port}`,
              },
              mcp: {
                servers: {
                  docs: {
                    url: service.url,
                    transport: "streamable-http",
                    auth: "oauth",
                    oauth: { identity: "per-requester" },
                  },
                },
              },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "full" },
            } satisfies OpenClawConfig;
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token,
              portClaim,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "http://localhost",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            const client = gateway.client;
            const self = await client.request<UsersSelfResult>("users.self", {});
            const created = await client.request<{ key: string }>("sessions.create", {
              agentId: "main",
              label: "Requester OAuth proof",
            });
            const send = async (message: string) => {
              const runId = randomUUID();
              await client.request("chat.send", {
                sessionKey: created.key,
                message,
                idempotencyKey: runId,
              });
              return await client.request<AgentWaitResult>(
                "agent.wait",
                { runId, timeoutMs: 45_000 },
                { timeoutMs: 50_000 },
              );
            };

            expect(await send(CONNECT_PROMPT)).toMatchObject({ status: "ok" });
            expect(model.searchResults.at(-1)).toContain("docs__connect");
            expect(model.searchResults.at(-1)).not.toContain("docs__whoami");
            const signIn = model.toolResults.at(-1)?.match(/https?:\/\/\S+\/authorize\?\S+/u)?.[0];
            if (!signIn) {
              throw new Error("connect did not return a sign-in link");
            }

            service.approveAs(`profile:${self.profile.id}`);
            const authorize = await fetch(signIn.replaceAll("\\u0026", "&"), {
              redirect: "manual",
            });
            const callback = authorize.headers.get("location") ?? "";
            expect(new URL(callback).origin).toBe(`http://127.0.0.1:${gateway.port}`);
            const completed = await fetch(callback);
            expect(completed.status).toBe(200);
            expect(await completed.text()).toContain("<title>Account connected</title>");

            expect(await send(WHOAMI_PROMPT)).toMatchObject({ status: "ok" });
            expect(model.searchResults.at(-1)).toContain("docs__whoami");
            expect(model.searchResults.at(-1)).not.toContain("docs__connect");
            expect(model.toolResults.at(-1)).toContain(`account:profile:${self.profile.id}`);
          },
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "requester OAuth proof complete" }),
          () => service?.close(),
          async () => {
            model?.reservation.listener.closeAllConnections();
            await model?.reservation.releaseListener();
          },
          () => model?.reservation.claim.release(),
        );
      },
    );
  },
);
