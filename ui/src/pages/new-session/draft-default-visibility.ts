import type { UsersPrefsGetResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

type DefaultSessionVisibility = "shared" | "private" | undefined;

const pick = (value: unknown): DefaultSessionVisibility =>
  value === "private" || value === "shared" ? value : undefined;

/**
 * Fork: the person's effective new-session default, their preference else the Gateway's.
 * A failed read is not an answer, so callers keep their current default.
 */
export async function readDefaultSessionVisibility(
  client: GatewayBrowserClient,
): Promise<{ ok: true; value: DefaultSessionVisibility } | { ok: false }> {
  try {
    const result = await client.request<UsersPrefsGetResult>("users.prefs.get", {
      keys: ["sessions.defaultVisibility", "gateway.sessions.defaultVisibility"],
    });
    if (result.status !== "ok") {
      return { ok: false };
    }
    return {
      ok: true,
      value:
        pick(result.entries["sessions.defaultVisibility"]) ??
        pick(result.entries["gateway.sessions.defaultVisibility"]),
    };
  } catch {
    return { ok: false };
  }
}
