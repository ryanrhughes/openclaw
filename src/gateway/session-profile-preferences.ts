import type { SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCanonicalUserPreferences } from "../state/user-preferences.js";

export const SESSION_DEFAULT_VISIBILITY_PREFERENCE = "sessions.defaultVisibility";
export const SESSION_SHOW_OTHERS_PRIVATE_PREFERENCE = "sessions.showOthersPrivate";
export const GATEWAY_DEFAULT_VISIBILITY_PREFERENCE = "gateway.sessions.defaultVisibility";

type SessionProfilePreferences = {
  defaultVisibility?: "shared" | "private";
  showOthersPrivate: boolean;
};

const preferencesByProfileId = new Map<string, SessionProfilePreferences>();

function parsePreferences(entries: Record<string, unknown>): SessionProfilePreferences {
  const defaultVisibility = entries[SESSION_DEFAULT_VISIBILITY_PREFERENCE];
  return {
    ...(defaultVisibility === "shared" || defaultVisibility === "private"
      ? { defaultVisibility }
      : {}),
    showOthersPrivate: entries[SESSION_SHOW_OTHERS_PRIVATE_PREFERENCE] === true,
  };
}

export async function loadSessionProfilePreferences(
  profileId: string,
): Promise<SessionProfilePreferences | undefined> {
  const preferences = await getCanonicalUserPreferences(profileId, [
    SESSION_DEFAULT_VISIBILITY_PREFERENCE,
    SESSION_SHOW_OTHERS_PRIVATE_PREFERENCE,
  ]);
  if (!preferences) {
    return undefined;
  }
  const parsed = parsePreferences(preferences.entries);
  preferencesByProfileId.set(preferences.profileId, parsed);
  preferencesByProfileId.set(profileId, parsed);
  return parsed;
}

export function applySessionProfilePreferenceChanges(
  profileId: string,
  entries: Record<string, unknown>,
): void {
  const current = preferencesByProfileId.get(profileId) ?? {
    showOthersPrivate: false,
  };
  const next = { ...current };
  if (Object.hasOwn(entries, SESSION_DEFAULT_VISIBILITY_PREFERENCE)) {
    const value = entries[SESSION_DEFAULT_VISIBILITY_PREFERENCE];
    next.defaultVisibility = value === "shared" || value === "private" ? value : undefined;
  }
  if (Object.hasOwn(entries, SESSION_SHOW_OTHERS_PRIVATE_PREFERENCE)) {
    next.showOthersPrivate = entries[SESSION_SHOW_OTHERS_PRIVATE_PREFERENCE] === true;
  }
  preferencesByProfileId.set(profileId, next);
}

export function hasSessionProfilePreferences(profileId: string): boolean {
  return preferencesByProfileId.has(profileId);
}

export function profileShowsOthersPrivate(profileId: string): boolean {
  return preferencesByProfileId.get(profileId)?.showOthersPrivate === true;
}

export function resolveGatewayDefaultSessionVisibility(cfg: OpenClawConfig): "shared" | "private" {
  return cfg.session?.sharing?.drafts === false
    ? "shared"
    : (cfg.session?.sharing?.defaultVisibility ?? "shared");
}

/**
 * Resolves visibility for a new session row without touching the state database: the
 * creator's preferences come from the cache warmed at connection admission and kept
 * current by users.prefs.set, so creation paths stay synchronous and worker-safe.
 */
export function resolveNewSessionVisibility(params: {
  cfg: OpenClawConfig;
  creator?: SessionCreatedActor;
  explicit?: SessionVisibility;
  inheritsDraft?: boolean;
  isMainSession: boolean;
}): SessionVisibility | undefined {
  if (params.isMainSession) {
    return params.explicit === "draft" ? undefined : params.explicit;
  }
  if (params.explicit) {
    return params.explicit;
  }
  if (params.cfg.session?.sharing?.drafts === false) {
    return undefined;
  }
  if (params.inheritsDraft) {
    return "draft";
  }
  const profileId =
    params.creator?.type === "human" && params.creator.source === "profile"
      ? params.creator.id
      : undefined;
  const preference = profileId
    ? (preferencesByProfileId.get(profileId)?.defaultVisibility ??
      resolveGatewayDefaultSessionVisibility(params.cfg))
    : "shared";
  return preference === "private" ? "draft" : undefined;
}
