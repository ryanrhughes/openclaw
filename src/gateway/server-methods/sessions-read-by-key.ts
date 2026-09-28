import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateSessionsDescribeParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
} from "../session-sharing.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { loadSessionEntriesForTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionByKeyReadHandlers: GatewayRequestHandlers = {
  "sessions.describe": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    while (true) {
      const prepared = await projection.withPreparedExactRows(
        (cfg) => {
          const agent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
          const denied = authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: key,
            target: null,
          });
          return agent.ok && !denied ? [{ key, agentId: agent.agentId }] : [];
        },
        (read) => {
          const requestedAgent = resolveRequestedSessionAgentId(
            read.state.cfg,
            key,
            params.agentId,
          );
          if (!requestedAgent.ok) {
            respond(false, undefined, requestedAgent.error);
            return;
          }
          const query = { key, agentId: requestedAgent.agentId };
          const presentation = prepareProjectedSessionPresentation(read, client);
          const denied = presentation.authorizeDescription(query);
          if (denied) {
            respond(false, undefined, denied);
            return;
          }
          const record = read.describe(query);
          if (
            !record ||
            (!isGatewayAdmin(client ?? null) &&
              presentation.sharing.sessionCap !== undefined &&
              presentation.sharing.entryFilter?.(
                record.key,
                record.entry,
                presentation.target(query) ?? undefined,
              ) === false)
          ) {
            respond(true, { session: null });
            return;
          }
          respond(true, { session: presentation.present(record, params) });
        },
      );
      if (prepared.kind === "complete") {
        return;
      }
      const { certifySessionCanonicalValidationPending } =
        await import("../../config/sessions/session-canonical-validation-readiness.js");
      await certifySessionCanonicalValidationPending(prepared.database);
    }
  },
  "sessions.get": async ({ params, respond, context, client }) => {
    // SAFETY: Gateway dispatch supplies object params; each optional field is narrowed before use.
    const p = params as {
      key?: unknown;
      sessionKey?: unknown;
      limit?: unknown;
      agentId?: unknown;
    };
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(
      cfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { target, storePath, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    const boundaryFilter = hasOperatorBoundary(client, cfg)
      ? createSessionListEntryFilter({ client, cfg }, undefined, undefined, {
          adminDirectAccess: true,
        })
      : undefined;
    if (
      !entry?.sessionId ||
      boundaryFilter?.(target.canonicalKey, entry, sharingTargetFor(target, storePath, entry)) ===
        false
    ) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const sessionId = entry.sessionId;
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      {
        agentId: target.agentId,
        sessionEntry: entry,
        sessionId,
        sessionKey: target.canonicalKey,
        storePath,
      },
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
        allowResetArchiveFallback: true,
      },
    );
    const currentCfg = context.getRuntimeConfig();
    const currentRequestedAgent = resolveRequestedSessionAgentId(
      currentCfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    const current = currentRequestedAgent.ok
      ? loadSessionEntriesForTarget({
          key,
          cfg: currentCfg,
          agentId: currentRequestedAgent.agentId,
        })
      : null;
    const currentBoundaryFilter = hasOperatorBoundary(client, currentCfg)
      ? createSessionListEntryFilter({ client, cfg: currentCfg }, undefined, undefined, {
          adminDirectAccess: true,
        })
      : undefined;
    if (
      !current ||
      current.target.agentId !== target.agentId ||
      current.target.canonicalKey !== target.canonicalKey ||
      current.storePath !== storePath ||
      current.entry?.sessionId !== sessionId ||
      (current.entry !== undefined &&
        currentBoundaryFilter?.(
          current.target.canonicalKey,
          current.entry,
          sharingTargetFor(current.target, current.storePath, current.entry),
        ) === false)
    ) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    respond(true, { messages }, undefined);
  },
};

function sharingTargetFor(
  target: { agentId: string; canonicalKey: string; storeKeys: string[] },
  storePath: string,
  entry: SessionEntry,
): SessionSharingTarget {
  return {
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    entry,
    storeKey: target.storeKeys[0] ?? target.canonicalKey,
    storeKeys: target.storeKeys,
    storePath,
  };
}
