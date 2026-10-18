/** Issues requester principals for per-requester MCP accounts beyond trusted channel senders. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyTurnParticipants } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import type { McpRequesterPrincipal } from "./agent-bundle-mcp-types.js";
import type { AnyAgentTool } from "./tools/common.js";

// Source and bundled module instances must recognize the same host-issued object.
const issuedPrincipals = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpRequesterPrincipal.issued"),
  () => new WeakSet<object>(),
);

/**
 * Channel senders keep their existing identity, so this returns nothing for them.
 * Otherwise the turn's verified requester profile selects the principal, and only
 * while it is the profile of the run's live operator authority, the run is active,
 * and nobody else has joined the turn. Runs without that turn binding (cron,
 * heartbeats, subagents) stay fail-closed, as they do for channel senders.
 */
export function resolveMcpRequesterPrincipal(params: {
  senderId?: string | null;
  turnRequesterProfileId?: string;
  admittedRunContext?: AdmittedRunContext;
  assertRunActive?: () => void;
  readTurnParticipants: () => ReplyTurnParticipants | undefined;
}): McpRequesterPrincipal | undefined {
  const profileId = normalizeOptionalString(params.turnRequesterProfileId);
  if (normalizeOptionalString(params.senderId) || !profileId || profileId.includes("\0")) {
    return undefined;
  }
  let authority: ReturnType<typeof readAdmittedRunOperatorAuthority>;
  try {
    authority = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  } catch {
    return undefined;
  }
  if (!authority || authority.profileId !== profileId) {
    return undefined;
  }
  const liveAuthority = authority;
  const assertCurrent = () => {
    params.assertRunActive?.();
    liveAuthority.assertCurrent();
    // Steering by someone else must not borrow this person's account for the rest of the turn.
    let participant: ReturnType<ReplyTurnParticipants["resolve"]>;
    try {
      participant = params.readTurnParticipants()?.resolve();
    } catch {
      participant = undefined;
    }
    if (participant?.profileId !== profileId) {
      throw new Error(
        "Personal MCP accounts work only for the person who started this turn, while it runs and nobody else has joined it. Ask again in a new message.",
      );
    }
  };
  const principal: McpRequesterPrincipal = Object.freeze({
    kind: "gateway-profile",
    profileId,
    assertCurrent,
  });
  if (!isMcpRequesterPrincipalCurrent(principal)) {
    return undefined;
  }
  issuedPrincipals.add(principal);
  return principal;
}

/** Accepts only host-issued principals; structurally identical lookalikes resolve to none. */
export function readMcpRequesterPrincipal(
  value: McpRequesterPrincipal | undefined,
): McpRequesterPrincipal | undefined {
  return value && issuedPrincipals.has(value) ? value : undefined;
}

/**
 * Sign-in and requester-scoped tool, resource, and prompt calls borrow the
 * principal's account: each revalidates before it starts, and its result is
 * withheld if the principal went stale meanwhile (a completed side effect stays).
 * Wraps freshly built tools in place to keep their metadata identity.
 */
export function guardMcpRequesterTools(
  tools: readonly AnyAgentTool[],
  principal: McpRequesterPrincipal | undefined,
  isRequesterScopedServer: (serverName: string) => boolean,
): void {
  if (!principal) {
    return;
  }
  for (const tool of tools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (!mcp || (!mcp.oauthConnectBootstrap && !isRequesterScopedServer(mcp.serverName))) {
      continue;
    }
    const execute = tool.execute;
    tool.execute = async (...args: Parameters<typeof execute>) => {
      principal.assertCurrent();
      const result = await execute(...args);
      principal.assertCurrent();
      return result;
    };
  }
}

export function isMcpRequesterPrincipalCurrent(principal: McpRequesterPrincipal | undefined) {
  try {
    principal?.assertCurrent();
    return principal !== undefined;
  } catch {
    return false;
  }
}
