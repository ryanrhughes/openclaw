import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpRequesterPrincipal,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { requesterMcpOAuthIdentity, type McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { resolveMcpRequesterPrincipal } from "./mcp-requester-principal.js";

const oauthStatus = vi.hoisted(() => vi.fn());
const startAuthorization = vi.hoisted(() => vi.fn());

vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: oauthStatus,
  startMcpOAuthAuthorization: startAuthorization,
}));

function createTestRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0],
  options: { resources?: boolean } = {},
): SessionMcpRuntime {
  const includesCalendar = params.includeServerNames?.has("calendar") === true;
  const catalog: McpToolCatalog = includesCalendar
    ? {
        version: 1,
        generatedAt: 1,
        servers: {
          calendar: {
            serverName: "calendar",
            safeServerName: "calendar",
            launchSummary: "calendar",
            toolCount: 1,
            ...(options.resources ? { resources: { listChanged: false } } : {}),
          },
        },
        tools: [
          {
            serverName: "calendar",
            safeServerName: "calendar",
            toolName: "events",
            description: "List events",
            fallbackDescription: "List events",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }
    : { version: 1, generatedAt: 1, servers: {}, tools: [] };
  let lastUsedAt = Date.now();
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint: params.configFingerprint ?? "test",
    requesterScope: params.requesterScope,
    requesterConnect: params.requesterConnect,
    isRequesterScopedServer: () => params.requesterScope !== undefined,
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    callTool: async (_serverName, toolName) => ({
      content: [{ type: "text", text: `called:${toolName}` }],
      isError: false,
    }),
    ...(options.resources
      ? { readResource: async () => ({ contents: [{ uri: "calendar://agenda", text: "agenda" }] }) }
      : {}),
    dispose: async () => {},
    joinCleanup: async () => {},
  };
}

describe("requester MCP connect runtime", () => {
  let manager: ReturnType<typeof createSessionMcpRuntimeManager>;
  const created: Array<Parameters<CreateSessionMcpRuntime>[0]> = [];

  beforeEach(() => {
    oauthStatus
      .mockReset()
      .mockImplementation(async (identities: readonly McpOAuthIdentity[]) =>
        identities.map(() => ({ state: "unauthenticated" })),
      );
    startAuthorization.mockReset().mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
      redirectUrl: "https://gateway.example/oauth/mcp/callback",
      state: "opaque",
    });
    created.length = 0;
    manager = createSessionMcpRuntimeManager({
      createRuntime: (params) => {
        created.push(params);
        return createTestRuntime(params);
      },
    });
  });

  afterEach(async () => {
    await manager.disposeAll();
    await resetCodeModeTestState();
  });

  it("materializes connect before authorization and real tools on the next message", async () => {
    const request = {
      sessionId: "session-connect",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      messageChannel: "telegram",
      agentAccountId: "bot",
      cfg: {
        gateway: { publicOrigin: "https://gateway.example" },
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              transport: "streamable-http" as const,
              auth: "oauth" as const,
              oauth: { identity: "per-requester" as const },
            },
          },
        },
      },
    };

    const disconnectedRuntime = await manager.getOrCreate(request);
    const disconnected = await materializeBundleMcpToolsForRun({
      runtime: disconnectedRuntime,
    });
    expect(disconnected.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(created.find((params) => params.requesterScope)?.includeServerNames).toEqual(new Set());
    expect(startAuthorization).not.toHaveBeenCalled();
    const connecting = disconnected.tools[0]!.execute("connect", {});
    expect(startAuthorization).toHaveBeenCalledOnce();
    await expect(connecting).resolves.toMatchObject({
      details: {
        mcpConnect: {
          serverName: "calendar",
          authorizationUrl: "https://auth.example/authorize?state=opaque",
        },
      },
    });
    startAuthorization
      .mockResolvedValueOnce({
        status: "redirect",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      })
      .mockResolvedValueOnce({ status: "authorized" });
    const codeMode = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeMode.tools, ...disconnected.tools],
      config: codeMode.config,
      catalogRef: codeMode.catalogRef,
    });
    const guest = await runUntilCompleted({
      execTool: codeMode.tools[0]!,
      waitTool: codeMode.tools[1]!,
      code: "return { signIn: await MCP.calendar.connect(), connected: await MCP.calendar.connect() };",
    });
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual({
      signIn: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("https://auth.example/authorize?state=opaque"),
          },
        ],
        isError: false,
      },
      connected: {
        content: [{ type: "text", text: expect.stringContaining('"calendar" is connected') }],
        isError: false,
      },
    });
    expect(disconnected.tools[0]?.resultContentSource).toBe("network");
    await disconnected.dispose();

    oauthStatus.mockImplementation(async (identities: readonly McpOAuthIdentity[]) =>
      identities.map(() => ({ state: "authorized" })),
    );
    const connectedRuntime = await manager.getOrCreate(request);
    const connected = await materializeBundleMcpToolsForRun({ runtime: connectedRuntime });

    expect(connected.tools.map((tool) => tool.name)).toEqual(["calendar__events"]);
    expect(created.findLast((params) => params.requesterScope)?.includeServerNames).toEqual(
      new Set(["calendar"]),
    );
    await connected.dispose();
  });

  it("returns requester connection configuration failures as failed MCP guest results", async () => {
    const runtime = await manager.getOrCreate({
      sessionId: "session-connect-missing-origin",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      cfg: {
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              transport: "streamable-http",
              auth: "oauth",
              oauth: { identity: "per-requester" },
            },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const direct = await materialized.tools[0]!.execute("connect-direct", {});
    expect(direct.details).toMatchObject({ status: "error", mcpServer: "calendar" });

    const codeMode = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeMode.tools, ...materialized.tools],
      config: codeMode.config,
      catalogRef: codeMode.catalogRef,
    });
    const guest = await runUntilCompleted({
      execTool: codeMode.tools[0]!,
      waitTool: codeMode.tools[1]!,
      code: "return await MCP.calendar.connect();",
    });
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual({
      content: [{ type: "text", text: expect.stringContaining("gateway.publicOrigin") }],
      isError: true,
    });
    expect(guest.value).not.toHaveProperty("details");
    await materialized.dispose();
  });

  it("keeps signed-in profiles on their own accounts in one shared session", async () => {
    const ada = { profileId: "profile-ada", senderId: "profile-ada", name: "Ada" };
    const bo = { profileId: "profile-bo", senderId: "profile-bo", name: "Bo" };
    const serverUrl = "https://mcp.example/rpc";
    const profileIdentity = (profileId: string) =>
      requesterMcpOAuthIdentity("calendar", serverUrl, {
        requesterSenderId: profileId,
        requesterKind: "gateway-profile",
      });
    oauthStatus.mockImplementation(async (identities: readonly McpOAuthIdentity[]) =>
      identities.map((identity) => ({
        state:
          identity.storeKey === profileIdentity(ada.profileId).storeKey
            ? "authorized"
            : "unauthenticated",
      })),
    );
    const request = {
      sessionId: "session-shared",
      workspaceDir: "/workspace",
      messageChannel: "webchat",
      cfg: {
        gateway: { publicOrigin: "https://gateway.example" },
        mcp: {
          servers: {
            calendar: {
              url: serverUrl,
              transport: "streamable-http" as const,
              auth: "oauth" as const,
              oauth: { identity: "per-requester" as const },
            },
          },
        },
      },
    };
    const turnFor = (person: typeof ada) => ({
      owner: person,
      runId: `${person.profileId}-run`,
      sessionId: `${person.profileId}-turn`,
      sessionKey: `agent:main:${person.profileId}-turn`,
    });
    const profileManager = createSessionMcpRuntimeManager({
      createRuntime: (params) => {
        created.push(params);
        return createTestRuntime(params, { resources: true });
      },
    });
    try {
      await withPersonalToolTurn(turnFor(ada), async (adaTurn) =>
        withPersonalToolTurn(turnFor(bo), async (boTurn) => {
          const principalFor = (turn: typeof adaTurn, person: typeof ada) =>
            resolveMcpRequesterPrincipal({
              turnRequesterProfileId: person.profileId,
              admittedRunContext: turn.admittedRunContext,
              readTurnParticipants: () => turn.operation.personalToolParticipants,
            });
          const materializeFor = async (principal: McpRequesterPrincipal | undefined) =>
            await materializeBundleMcpToolsForRun({
              runtime: await profileManager.getOrCreate({
                ...request,
                requesterPrincipal: principal,
              }),
              requesterPrincipal: principal,
            });
          const adaPrincipal = principalFor(adaTurn, ada);
          const boPrincipal = principalFor(boTurn, bo);
          const adaTools = await materializeFor(adaPrincipal);
          const boTools = await materializeFor(boPrincipal);

          expect(adaTools.tools.map((tool) => tool.name)).toEqual([
            "calendar__events",
            "calendar__resources_list",
            "calendar__resources_read",
          ]);
          expect(boTools.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
          expect(created.flatMap((params) => params.requesterScope ?? [])).toEqual([
            { requesterSenderId: ada.profileId, requesterKind: "gateway-profile" },
            { requesterSenderId: bo.profileId, requesterKind: "gateway-profile" },
          ]);
          await boTools.tools[0]!.execute("connect", {});
          expect(startAuthorization).toHaveBeenCalledOnce();
          expect(startAuthorization.mock.calls[0]?.[0]).toEqual(profileIdentity(bo.profileId));

          // A copied principal is not host-issued, so it selects no requester account.
          const forged = await materializeFor(adaPrincipal && { ...adaPrincipal });
          expect(forged.tools).toEqual([]);

          // Once Bo steers Ada's turn, Ada's account refuses the rest of that turn,
          // including resource reads, and a retry drops only the requester partition.
          await adaTurn.steer(bo);
          for (const tool of adaTools.tools) {
            await expect(tool.execute(tool.name, { uri: "calendar://agenda" })).rejects.toThrow(
              "only for the person who started this turn",
            );
          }
          const retried = await materializeFor(adaPrincipal);
          expect(retried.tools).toEqual([]);
          await Promise.all([
            adaTools.dispose(),
            boTools.dispose(),
            forged.dispose(),
            retried.dispose(),
          ]);
        }),
      );
    } finally {
      await profileManager.disposeAll();
    }
  });

  it("drops only the requester partition when its principal goes stale mid-acquisition", async () => {
    const ada = { profileId: "profile-ada", senderId: "profile-ada", name: "Ada" };
    const bo = { profileId: "profile-bo", senderId: "profile-bo", name: "Bo" };
    await withPersonalToolTurn({ owner: ada }, async (turn) => {
      const principal = resolveMcpRequesterPrincipal({
        turnRequesterProfileId: ada.profileId,
        admittedRunContext: turn.admittedRunContext,
        readTurnParticipants: () => turn.operation.personalToolParticipants,
      });
      // Bo steers while acquisition awaits Ada's credential status.
      oauthStatus.mockImplementationOnce(async (identities: readonly McpOAuthIdentity[]) => {
        await turn.steer(bo);
        return identities.map(() => ({ state: "authorized" }));
      });
      const runtime = await manager.getOrCreate({
        sessionId: "session-stale-principal",
        workspaceDir: "/workspace",
        requesterPrincipal: principal,
        cfg: {
          mcp: {
            servers: {
              calendar: {
                url: "https://mcp.example/rpc",
                transport: "streamable-http",
                auth: "oauth",
                oauth: { identity: "per-requester" },
              },
            },
          },
        },
      });
      const materialized = await materializeBundleMcpToolsForRun({
        runtime,
        requesterPrincipal: principal,
      });
      expect(oauthStatus).toHaveBeenCalledOnce();
      expect(materialized.tools).toEqual([]);
      await materialized.dispose();
    });
  });
});
