import { describe, expect, it } from "vitest";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  requesterMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
} from "./mcp-oauth-identity.js";
import {
  readMcpRequesterPrincipal,
  resolveMcpRequesterPrincipal,
} from "./mcp-requester-principal.js";

const ada = { profileId: "profile-ada", senderId: "profile-ada", name: "Ada" };
const bo = { profileId: "profile-bo", senderId: "profile-bo", name: "Bo" };
const SERVER_URL = "https://mcp.example.test/mcp";

type Turn = Parameters<Parameters<typeof withPersonalToolTurn>[1]>[0];

function resolveFor(
  turn: Turn,
  overrides: Partial<Parameters<typeof resolveMcpRequesterPrincipal>[0]> = {},
) {
  return resolveMcpRequesterPrincipal({
    turnRequesterProfileId: ada.profileId,
    admittedRunContext: turn.admittedRunContext,
    readTurnParticipants: () => turn.operation.personalToolParticipants,
    ...overrides,
  });
}

describe("per-requester MCP principal", () => {
  it("issues a principal only for a senderless turn's verified, live profile", async () => {
    await withPersonalToolTurn({ owner: ada }, async (turn) => {
      const principal = resolveFor(turn);
      expect(principal).toMatchObject({ kind: "gateway-profile", profileId: ada.profileId });
      expect(readMcpRequesterPrincipal(principal)).toBe(principal);
      expect(readMcpRequesterPrincipal({ ...principal! })).toBeUndefined();

      // Channel senders keep their sender-keyed accounts.
      expect(resolveFor(turn, { senderId: "telegram-user" })).toBeUndefined();
      // A claimed profile must be the run's own authority.
      expect(resolveFor(turn, { turnRequesterProfileId: bo.profileId })).toBeUndefined();
      // Cron, heartbeat, and subagent runs carry no turn requester.
      expect(resolveFor(turn, { turnRequesterProfileId: undefined })).toBeUndefined();
      expect(resolveFor(turn, { admittedRunContext: undefined })).toBeUndefined();

      // Runs without turn participants or an active run never borrow an account.
      expect(resolveFor(turn, { readTurnParticipants: () => undefined })).toBeUndefined();
      expect(
        resolveFor(turn, {
          assertRunActive: () => {
            throw new Error("run ended");
          },
        }),
      ).toBeUndefined();

      // Someone else steering the turn cannot borrow the requester's account, even on retry.
      expect(() => principal!.assertCurrent()).not.toThrow();
      await turn.steer(bo);
      expect(() => principal!.assertCurrent()).toThrow("only for the person who started this turn");
      expect(resolveFor(turn)).toBeUndefined();
    });
  });

  it("fails closed once the requester's access is revoked", async () => {
    await withPersonalToolTurn({ owner: ada }, async (turn) => {
      const principal = resolveFor(turn);
      turn.revoke(ada.profileId);
      expect(() => principal!.assertCurrent()).toThrow();
      expect(resolveFor(turn)).toBeUndefined();
    });
  });

  it("keeps profile accounts apart from channel senders without moving existing rows", () => {
    const profile = requesterMcpOAuthIdentity("docs", SERVER_URL, {
      requesterSenderId: "ada",
      requesterKind: "gateway-profile",
    });
    const senderLookalikes = [
      { requesterSenderId: "ada" },
      { requesterSenderId: "ada", messageChannel: "gateway-profile" },
      { requesterSenderId: "ada", agentAccountId: "gateway-profile" },
      { requesterSenderId: "", messageChannel: "gateway-profile", agentAccountId: "ada" },
    ];
    for (const scope of senderLookalikes) {
      expect(requesterMcpOAuthIdentity("docs", SERVER_URL, scope).storeKey).not.toBe(
        profile.storeKey,
      );
    }
    // The callback, cleanup, and principal counts recognize requester rows by this prefix.
    expect(profile.storeKey.startsWith(requesterMcpOAuthStoreKeyPrefix("docs", SERVER_URL))).toBe(
      true,
    );
    expect(
      requesterMcpOAuthIdentity("docs", SERVER_URL, {
        requesterSenderId: "ada",
        messageChannel: "telegram",
        agentAccountId: "bot",
      }).storeKey,
    ).toBe("docs-0571b87feee6ea6b-r-a42a3976b85dd03f");
    expect(() =>
      requesterMcpOAuthIdentity("docs", SERVER_URL, {
        requesterSenderId: "ada\0bot",
        requesterKind: "gateway-profile",
      }),
    ).toThrow("cannot contain NUL");
  });
});
