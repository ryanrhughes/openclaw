import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  authorizeCurrentOperatorRoleScopes,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import { readSessionMembershipSnapshot } from "./session-membership-snapshot.js";
import { profileShowsOthersPrivate } from "./session-profile-preferences.js";
import {
  authorizeSessionSharingTarget,
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  sharingIdentity,
  type SessionSharingRoleParams,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { loadCachedSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

/** Published membership snapshot only; unknown sessions or members fail closed. */
function snapshotMember(sessionKey: string | undefined, identityId: string): boolean {
  return (
    sessionKey !== undefined &&
    readSessionMembershipSnapshot({ sessionKey })?.includes(identityId) === true
  );
}

function loadSharingSnapshot(params: Parameters<typeof resolveSessionSharingTarget>[0]) {
  const { sessionKey, agentId } = params;
  return loadCachedSessionSharingSnapshot({
    agentId,
    sessionKey,
    resolve: () => {
      const target = resolveSessionSharingTarget(params);
      return {
        canonicalKey: target?.canonicalKey ?? sessionKey,
        canonicalAgentId: target?.agentId ?? agentId,
        snapshot: {
          // Missing rows occur after deletion. Fail closed here; the delete path also
          // emits an unscoped catalog invalidation so identified readers still refresh.
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          ...(target ? { createdActor: target.entry.createdActor } : {}),
          ...(target?.entry.privateAccessRoot
            ? { privateAccessRoot: target.entry.privateAccessRoot }
            : {}),
        },
      };
    },
  });
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  policyConfig?: OpenClawConfig;
  client: GatewayClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
  prepared?: {
    sharing: ReturnType<typeof prepareSessionSharing>;
    target: (sessionKey: string, agentId?: string) => SessionSharingTarget | null;
  };
}): boolean {
  const { cfg, policyConfig = cfg, client, sessionKeys, event } = params;
  const operatorActor = resolveGatewayOperatorRoleActor(client);
  if (
    operatorActor?.kind === "operator" &&
    authorizeCurrentOperatorRoleScopes(client, policyConfig)
  ) {
    return false;
  }
  const admin = isGatewayAdmin(client);
  const identity = sharingIdentity(client, operatorActor);
  if (admin && (!identity || profileShowsOthersPrivate(identity.id))) {
    return true;
  }
  if (!identity) {
    return (
      (!operatorScopeSatisfied("operator.sessions.read", client.connect.scopes ?? []) ||
        operatorActor?.kind === "system" ||
        operatorScopeSatisfied("operator.read", client.connect.scopes ?? [])) &&
      (!policyConfig.gateway?.roles || operatorActor?.kind === "system") &&
      event !== "session.suggestion" &&
      event !== "session.typing"
    );
  }
  const sharing = params.prepared?.sharing ?? prepareSessionSharing({ cfg: policyConfig, client });
  const hidesForeignSessions =
    (params.prepared ? sharing.sessionCap : operatorSessionCap(client, policyConfig)) === "none";
  // Discovery remains lazy; these facts belong only to this recipient check, never a socket send.
  const lookup = params.prepared
    ? undefined
    : {
        agentId: params.agentId,
        exactRead: sessionKeys.length === 1,
        storeCache: new Map(),
        targetDiscoveryCache: new Map(),
      };
  const resolveTarget = (sessionKey: string) =>
    params.prepared
      ? params.prepared.target(sessionKey, params.agentId)
      : resolveSessionSharingTarget({ cfg, ...lookup, sessionKey });
  const visible = sessionKeys.every((sessionKey) => {
    const target = params.prepared ? resolveTarget(sessionKey) : undefined;
    const snapshot = params.prepared
      ? {
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          createdActor: target?.entry.createdActor,
          privateAccessRoot: target?.entry.privateAccessRoot,
        }
      : loadSharingSnapshot({ cfg, ...lookup, sessionKey });
    const isCreator = sharing.isCreator(snapshot.createdActor);
    // Admins keep stock event access to non-private sessions; only others' private ones filter.
    if ((snapshot.incognito && !admin) || (hidesForeignSessions && !isCreator && !admin)) {
      return false;
    }
    if (snapshot.visibility !== "draft" || isCreator) {
      return true;
    }
    // Membership comes from prepared projection rows or the published snapshot, never a
    // store lookup; a none cap was rejected above for non-admins.
    const privateTarget = params.prepared ? resolveTarget(sessionKey) : null;
    return (
      (privateTarget
        ? sharing.isMember(privateTarget, identity.id)
        : snapshotMember(sessionKey, identity.id)) ||
      snapshotMember(snapshot.privateAccessRoot, identity.id)
    );
  });
  if (!visible || event !== "session.suggestion") {
    return visible;
  }
  const authorId =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id // SAFETY: publishSuggestion emits SessionSuggestionEvent; this only reads the optional author id.
      : undefined;
  if (authorId === identity.id) {
    return true;
  }
  return sessionKeys.every((sessionKey) => {
    const target = resolveTarget(sessionKey);
    return target !== null && sharing.roleForTarget(target) !== "viewer";
  });
}

/** Share caller facts across synchronous selection/role projection, never across an await. */
export function prepareSessionSharing(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  prepared?: {
    aliases: ReadonlySet<string>;
    sessionCap: ReturnType<typeof operatorSessionCap>;
    isMember: (target: SessionSharingTarget, identityId: string) => boolean;
    target?: (sessionKey: string) => SessionSharingTarget | null;
  },
) {
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const isCreator = prepareSessionCreatorProfile(identity?.id, prepared?.aliases);
  const roleForTarget = (target: SessionSharingTarget, isMember?: boolean) =>
    resolveSessionSharingRole(
      {
        ...params,
        target,
        isMember:
          isMember ?? (prepared && Boolean(identity && prepared.isMember(target, identity.id))),
      },
      prepared && { value: prepared.sessionCap },
      isCreator,
    );
  return {
    isCreator,
    isMember: (target: SessionSharingTarget, identityId: string) =>
      prepared?.isMember(target, identityId) ??
      readSessionMembershipSnapshot({
        sessionKey: target.storeKey,
        storePath: target.storePath,
      })?.includes(identityId) === true,
    sessionCap: prepared?.sessionCap,
    entryFilter: createSessionListEntryFilter(params, isCreator, prepared),
    roleForTarget,
    authorizeTarget: (target: SessionSharingTarget) =>
      authorizeSessionSharingTarget(
        { ...params, target },
        prepared && { value: prepared.sessionCap, role: roleForTarget(target) },
      ),
  };
}

export function prepareProjectedSessionSharing(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  isMember: (target: SessionSharingTarget, identityId: string) => boolean;
  target: (sessionKey: string) => SessionSharingTarget | null;
}) {
  const { cfg, client, isMember, target } = params;
  if (client?.internal?.syntheticClient) {
    prepareGatewayRecipientProfile(client);
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, actor);
  const retained = client?.preparedSessionProfile;
  const profile = identity && retained?.aliases.has(identity.id) ? retained : undefined;
  const roleProfile =
    actor?.kind === "operator" && retained?.aliases.has(actor.profileId) ? retained : undefined;
  const sessionCap =
    actor?.kind === "system"
      ? undefined
      : resolveOperatorRolePolicyForAssignment(
          roleProfile?.profileId,
          roleProfile?.role ?? null,
          cfg,
        )?.sessions.others;
  return prepareSessionSharing(params, {
    aliases: profile?.aliases ?? new Set(),
    sessionCap,
    isMember,
    target,
  });
}

export function createSessionListEntryFilter(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
  prepared?: {
    sessionCap: ReturnType<typeof operatorSessionCap>;
    isMember?: (target: SessionSharingTarget, identityId: string) => boolean;
    target?: (sessionKey: string) => SessionSharingTarget | null;
  },
  options?: { adminDirectAccess?: boolean },
):
  | ((
      sessionKey: string | undefined,
      entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito" | "privateAccessRoot">,
      target?: SessionSharingTarget,
    ) => boolean)
  | undefined {
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  const admin = isGatewayAdmin(params.client);
  if (
    (admin &&
      (options?.adminDirectAccess || !identity || profileShowsOthersPrivate(identity.id))) ||
    (!identity && operatorActor?.kind === "system")
  ) {
    return undefined;
  }
  if (!identity) {
    return params.cfg?.gateway?.roles ? () => false : undefined;
  }
  const sessionCap = prepared
    ? prepared.sessionCap
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, identity.id));
  const memberMatches = (sessionKey: string | undefined, target?: SessionSharingTarget) => {
    if (!sessionKey) {
      return false;
    }
    // Never query SQLite here: prepared projections or the published membership snapshot only.
    const resolved = target ?? prepared?.target?.(sessionKey) ?? null;
    if (resolved && prepared?.isMember) {
      return prepared.isMember(resolved, identity.id);
    }
    return (
      readSessionMembershipSnapshot({
        sessionKey: resolved?.storeKey ?? sessionKey,
        storePath: resolved?.storePath,
      })?.includes(identity.id) === true
    );
  };
  const rootMatches = (root: string | undefined) => snapshotMember(root, identity.id);
  return (sessionKey, entry, target) => {
    if (!admin && (entry.incognito === true || isIncognitoSessionKey(sessionKey))) {
      return false;
    }
    if (resolveSessionVisibility(entry) !== "draft") {
      return admin || sessionCap !== "none" || creatorMatches(entry.createdActor);
    }
    return (
      creatorMatches(entry.createdActor) ||
      ((admin || sessionCap !== "none") &&
        (memberMatches(sessionKey, target) || rootMatches(entry.privateAccessRoot)))
    );
  };
}

export function createProfileSessionEntryFilter(
  params: {
    profileId: string;
    sessionCap?: ReturnType<typeof operatorSessionCap>;
    /** Admins keep every non-private session; others' private ones need membership or opt-in. */
    admin?: boolean;
  },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  // Unprepared filters (notably preview) may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  const memberMatches = (sessionKey: string | undefined, root: string | undefined) =>
    snapshotMember(sessionKey, params.profileId) || snapshotMember(root, params.profileId);
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito" | "privateAccessRoot">,
  ) => {
    const privateSession = resolveSessionVisibility(entry) === "draft";
    if (params.admin) {
      return (
        !privateSession ||
        creatorMatches(entry.createdActor) ||
        profileShowsOthersPrivate(params.profileId) ||
        memberMatches(sessionKey, entry.privateAccessRoot)
      );
    }
    return (
      entry.incognito !== true &&
      !isIncognitoSessionKey(sessionKey) &&
      (creatorMatches(entry.createdActor) ||
        (params.sessionCap !== "none" &&
          (!privateSession || memberMatches(sessionKey, entry.privateAccessRoot))))
    );
  };
}
