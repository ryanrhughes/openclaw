import { expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCanonicalUserPreferences } from "../state/user-preferences.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { loadSessionProfilePreferences } from "./session-profile-preferences.js";
import { canReceiveSessionEvent, resolveSessionMutationAuthorization } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  seedLinearSessionTranscript,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("private sessions outcome matrix", async () => {
  const { storePath } = await createSessionStoreDir();
  const base = (await getGatewayConfigModule()).getRuntimeConfig();
  const cfg: OpenClawConfig = {
    ...base,
    ...rolePolicyConfig(),
    session: {
      ...base.session,
      sharing: { ...base.session?.sharing, defaultVisibility: "private" },
    },
  };
  const context = { getRuntimeConfig: () => cfg };
  const profiles = {
    A: roleClient("write", "private-matrix-a"),
    B: roleClient("write", "private-matrix-b"),
    C: roleClient("write", "private-matrix-c"),
    D: roleClient("write", "private-matrix-d"),
    E: roleClient("write", "private-matrix-e"),
  };
  profiles.D.connect.scopes = ["operator.admin"];
  profiles.E.connect.scopes = ["operator.admin"];
  const profileId = (profile: keyof typeof profiles) =>
    profiles[profile].authenticatedUserProfile!.profileId;

  attachGatewayLocalUserIngress(
    profiles.A,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId: profileId("A"), displayName: "Matrix A" },
      isLocalClient: false,
    }),
  );
  await setCanonicalUserPreferences(profileId("E"), { "sessions.showOthersPrivate": true });
  await loadSessionProfilePreferences(profileId("E"));

  const shared = await directSessionReq<{ key: string }>(
    "sessions.create",
    { key: "agent:main:dashboard:private-matrix-shared", visibility: "shared" },
    { client: profiles.A, context },
  );
  expect(shared.ok, JSON.stringify(shared.error)).toBe(true);

  const created = await directSessionReq<{
    key: string;
    entry: { sessionId: string; visibility?: string };
  }>(
    "sessions.create",
    { key: "agent:main:dashboard:private-matrix" },
    { client: profiles.A, context },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.key;
  expect(created.payload?.entry).toMatchObject({ visibility: "draft" });
  expect(
    await directSessionReq(
      "session.members.add",
      { sessionKey, identityId: profileId("B") },
      { client: profiles.A, context },
    ),
  ).toMatchObject({ ok: true });
  await seedLinearSessionTranscript({
    agentId: "main",
    contents: ["private matrix history"],
    sessionId: created.payload!.entry.sessionId,
    sessionKey,
    storePath,
  });

  type MatrixRow = {
    listed: boolean;
    describe: boolean;
    history: boolean;
    event: boolean;
    send: boolean;
  };
  const rows = {} as Record<keyof typeof profiles, MatrixRow>;
  for (const profile of ["A", "B", "C", "D", "E"] as const) {
    const client = profiles[profile];
    const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>(
      "sessions.list",
      { agentId: "main" },
      { client, context },
    );
    const described = await directSessionReq<{ session: { key: string } | null }>(
      "sessions.describe",
      { key: sessionKey },
      { client, context },
    );
    const history = await directSessionReq<{ messages: unknown[] }>(
      "sessions.get",
      { key: sessionKey },
      { client, context },
    );
    const row = {
      listed: listed.payload?.sessions.some((session) => session.key === sessionKey) ?? false,
      describe: described.payload?.session !== null,
      history: (history.payload?.messages.length ?? 0) > 0,
      event: canReceiveSessionEvent({
        cfg,
        client,
        sessionKeys: [sessionKey],
        agentId: "main",
        event: "session.message",
      }),
      send:
        resolveSessionMutationAuthorization({
          client,
          method: "chat.send",
          requestParams: { sessionKey },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        }).error === null,
    };
    rows[profile] = row;
    console.log(
      `${profile} | ${row.listed ? "yes" : "no"} | ${row.describe ? "yes" : "no"} | ${row.history ? "yes" : "no"} | ${row.event ? "yes" : "no"} | ${row.send ? "yes" : "no"}`,
    );
  }

  expect(rows).toEqual({
    A: { listed: true, describe: true, history: true, event: true, send: true },
    B: { listed: true, describe: true, history: true, event: true, send: true },
    C: { listed: false, describe: false, history: false, event: false, send: false },
    D: { listed: false, describe: true, history: true, event: false, send: true },
    E: { listed: true, describe: true, history: true, event: true, send: true },
  });

  const page = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { agentId: "main", limit: 1 },
    { client: profiles.D, context },
  );
  expect(page.payload?.sessions).toHaveLength(1);
  expect(page.payload?.sessions[0]?.key).toBe(shared.payload?.key);

  const profilelessAdmin = {
    connect: { scopes: ["operator.admin"] },
  } as (typeof profiles)["D"];
  const profilelessList = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { agentId: "main" },
    { client: profilelessAdmin, context },
  );
  expect(profilelessList.payload?.sessions.some((session) => session.key === sessionKey)).toBe(
    true,
  );
  expect(
    canReceiveSessionEvent({
      cfg,
      client: profilelessAdmin,
      sessionKeys: [sessionKey],
      agentId: "main",
      event: "session.message",
    }),
  ).toBe(true);

  // A none-capped admin keeps shared-session events; only uninvited private events filter.
  const noneAdmin = roleClient("none", "private-matrix-f");
  noneAdmin.connect.scopes = ["operator.admin"];
  const adminEvent = (key: string) =>
    canReceiveSessionEvent({
      cfg,
      client: noneAdmin,
      sessionKeys: [key],
      agentId: "main",
      event: "session.message",
    });
  expect(adminEvent(shared.payload!.key)).toBe(true);
  expect(adminEvent(sessionKey)).toBe(false);

  // Without gateway.roles, uninvited profiles still cannot read a private session by key.
  const noRoles: OpenClawConfig = { ...cfg, gateway: { ...cfg.gateway, roles: undefined } };
  const noRolesContext = { getRuntimeConfig: () => noRoles };
  const read = async (client: (typeof profiles)[keyof typeof profiles]) => ({
    describe: (
      await directSessionReq<{ session: unknown }>(
        "sessions.describe",
        { key: sessionKey },
        { client, context: noRolesContext },
      )
    ).payload?.session,
    messages: (
      await directSessionReq<{ messages: unknown[] }>(
        "sessions.get",
        { key: sessionKey },
        { client, context: noRolesContext },
      )
    ).payload?.messages,
  });
  expect(await read(profiles.C)).toEqual({ describe: null, messages: [] });
  const invited = await read(profiles.B);
  expect(invited.describe).not.toBeNull();
  expect(invited.messages?.length ?? 0).toBeGreaterThan(0);
});
