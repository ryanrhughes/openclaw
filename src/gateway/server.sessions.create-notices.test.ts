import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { setCanonicalUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import { loadSessionProfilePreferences } from "./session-profile-preferences.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("sessions.create stamps trusted operator provenance and records created", async () => {
  const { storePath } = await createSessionStoreDir();
  const profileId = "profile-session-creator";
  const client = {
    connect: { scopes: ["operator.write"] },
    authenticatedUserProfile: {
      profileId,
      displayName: "Test Operator",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  attachGatewayLocalUserIngress(
    client,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId, displayName: "Test Operator" },
      isLocalClient: false,
    }),
  );
  const created = await directSessionReq<{
    key?: string;
    entry?: {
      createdVia?: string;
      createdActor?: { type: string; id?: string };
      createdAt?: number;
    };
  }>(
    "sessions.create",
    { agentId: "main", label: "Investigate build failure" },
    { client: client as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: profileId },
    createdAt: expect.any(Number),
  });
  expect(created.payload?.entry).not.toHaveProperty("createdActor.label");
  const key = expectDefined(created.payload?.key, "created session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("createdActor.label");
  expect(listSessionStateEventsSince(key, "main", 0, 20).events).toContainEqual(
    expect.objectContaining({
      kind: "created",
      actorType: "human",
      actorId: profileId,
      summary: "session created",
    }),
  );

  const notices = drainSystemEvents("agent:main:main");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("New session created");
  expect(notices[0]).toContain("Investigate build failure");
  expect(notices[0]).toContain(profileId);
  expect(notices[0]).toContain(key);
  expect(notices[0]).toContain("operator");

  const existing = await directSessionReq("sessions.create", { key }, { client: client as never });
  expect(existing.ok).toBe(true);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);

  const synthetic = await directSessionReq<{
    entry?: { createdVia?: string; createdActor?: unknown; createdAt?: number };
  }>(
    "sessions.create",
    { agentId: "main" },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: { syntheticClient: true },
      } as never,
    },
  );
  expect(synthetic.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdAt: expect.any(Number),
  });
  expect(synthetic.payload?.entry?.createdActor).toBeUndefined();

  for (const { actor, sandbox } of [
    { actor: { type: "agent", id: "main" }, sandbox: undefined },
    {
      actor: { type: "human", source: "profile", id: "profile-delegated-creator" },
      sandbox: "required",
    },
  ] as const) {
    // The required parent's creation policy survives removal of gateway.roles.
    const hinted = await directSessionReq<{
      key?: string;
      entry?: { createdVia?: string; createdActor?: unknown; sandbox?: "required" };
    }>(
      "sessions.create",
      { agentId: "main" },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            syntheticClient: true,
            sessionCreation: {
              via: "spawn",
              actor,
              sandbox,
              requesterSessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );
    expect(hinted.ok, JSON.stringify(hinted.error)).toBe(true);
    expect(hinted.payload?.entry).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(hinted.payload?.entry?.sandbox).toBe(sandbox);
    const hintedKey = expectDefined(hinted.payload?.key, "delegated session key");
    const stored = loadSessionEntry({ sessionKey: hintedKey, storePath });
    expect(stored).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(stored?.sandbox).toBe(sandbox);
  }
});

test("sessions.create resolves private defaults, profile overrides, explicit visibility, Home, and inheritance", async () => {
  const { storePath } = await createSessionStoreDir();
  const base = (await getGatewayConfigModule()).getRuntimeConfig();
  let cfg: OpenClawConfig = base;
  const context = { getRuntimeConfig: () => cfg };
  const clientFor = (profileId: string) => {
    const client = {
      connect: { scopes: ["operator.write"] },
      authenticatedUserProfile: {
        profileId,
        displayName: "Session Creator",
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    attachGatewayLocalUserIngress(
      client,
      prepareGatewayLocalUserIngress({
        authenticatedUserExpected: true,
        profile: { profileId, displayName: "Session Creator" },
        isLocalClient: false,
      }),
    );
    return client as never;
  };
  const create = async (name: string, profileId: string, params: Record<string, unknown> = {}) => {
    const key = `agent:main:dashboard:private-default-${name}`;
    const result = await directSessionReq<{ key: string }>(
      "sessions.create",
      { key, ...params },
      { client: clientFor(profileId), context },
    );
    expect(result.ok, `${name}: ${JSON.stringify(result.error)}`).toBe(true);
    return loadSessionEntry({ sessionKey: result.payload?.key ?? key, storePath });
  };

  const stockProfile = ensureProfileForEmail("stock-default@example.test");
  expect((await create("stock", stockProfile.id))?.visibility).toBeUndefined();

  cfg = { ...base, session: { ...base.session, sharing: { defaultVisibility: "private" } } };
  const privateProfile = ensureProfileForEmail("private-default@example.test");
  expect((await create("gateway-private", privateProfile.id))?.visibility).toBe("draft");

  const sharedOverride = ensureProfileForEmail("shared-override@example.test");
  await setCanonicalUserPreferences(sharedOverride.id, {
    "sessions.defaultVisibility": "shared",
  });
  await loadSessionProfilePreferences(sharedOverride.id);
  expect((await create("shared-override", sharedOverride.id))?.visibility).toBeUndefined();

  cfg = { ...base, session: { ...base.session, sharing: { defaultVisibility: "shared" } } };
  const privateOverride = ensureProfileForEmail("private-override@example.test");
  await setCanonicalUserPreferences(privateOverride.id, {
    "sessions.defaultVisibility": "private",
  });
  await loadSessionProfilePreferences(privateOverride.id);
  expect((await create("private-override", privateOverride.id))?.visibility).toBe("draft");

  const invalidOverride = ensureProfileForEmail("invalid-override@example.test");
  await setCanonicalUserPreferences(invalidOverride.id, {
    "sessions.defaultVisibility": "unexpected",
  });
  await loadSessionProfilePreferences(invalidOverride.id);
  expect((await create("invalid-override", invalidOverride.id))?.visibility).toBeUndefined();

  cfg = {
    ...base,
    session: { ...base.session, sharing: { drafts: false, defaultVisibility: "shared" } },
  };
  expect((await create("drafts-disabled", privateOverride.id))?.visibility).toBeUndefined();

  cfg = { ...base, session: { ...base.session, sharing: { defaultVisibility: "private" } } };
  expect(
    (await create("explicit-shared", privateOverride.id, { visibility: "shared" }))?.visibility,
  ).toBe("shared");

  const home = await directSessionReq<{ key: string }>(
    "sessions.create",
    { key: "agent:main:main", visibility: "draft" },
    { client: clientFor(privateOverride.id), context },
  );
  expect(home.ok, JSON.stringify(home.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.visibility).not.toBe(
    "draft",
  );

  const syntheticKey = "agent:main:dashboard:private-default-synthetic";
  const synthetic = await directSessionReq<{ key: string }>(
    "sessions.create",
    { key: syntheticKey },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: { syntheticClient: true },
      } as never,
      context,
    },
  );
  expect(synthetic.ok, JSON.stringify(synthetic.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: syntheticKey, storePath })?.visibility).toBeUndefined();

  const parent = await create("draft-parent", privateOverride.id, { visibility: "draft" });
  const parentKey = "agent:main:dashboard:private-default-draft-parent";
  expect(parent?.visibility).toBe("draft");
  const child = await create("draft-child", privateOverride.id, { parentSessionKey: parentKey });
  expect(child?.visibility).toBe("draft");
  const fork = await create("draft-fork", privateOverride.id, {
    parentSessionKey: parentKey,
    fork: true,
  });
  expect(fork?.visibility).toBe("draft");
});
