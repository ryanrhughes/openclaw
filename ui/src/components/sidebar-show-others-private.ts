import type { UsersPrefsGetResult } from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { readGatewayOperatorAccess } from "../app/operator-access.ts";
import { saveUserPreferences } from "../app/user-prefs-cache.ts";

const SHOW_OTHERS_PRIVATE_KEY = "sessions.showOthersPrivate";

/**
 * Admin-only sidebar declutter backed by the Gateway-enforced profile preference.
 * Fork: admins see others' private sessions only after opting in here.
 */
export class SidebarShowOthersPrivatePreference {
  private client: GatewayBrowserClient | undefined;

  constructor(
    private readonly read: () => boolean,
    private readonly write: (show: boolean) => void,
  ) {}

  /** Undefined hides the toggle for everyone but admins; loads once per gateway client. */
  option(snapshot: ApplicationGatewaySnapshot | undefined): boolean | undefined {
    if (!snapshot?.selfUser?.id || !readGatewayOperatorAccess(snapshot).canAdmin) {
      return undefined;
    }
    const client = snapshot.client ?? undefined;
    if (client && this.client !== client) {
      this.client = client;
      void client
        .request<UsersPrefsGetResult>("users.prefs.get", { keys: [SHOW_OTHERS_PRIVATE_KEY] })
        .then(
          (result) => {
            if (this.client === client && result.status === "ok") {
              this.write(result.entries[SHOW_OTHERS_PRIVATE_KEY] === true);
            }
          },
          () => undefined,
        );
    }
    return this.read();
  }

  async save(client: GatewayBrowserClient, show: boolean): Promise<boolean> {
    this.write(show);
    try {
      await saveUserPreferences(client, { entries: { [SHOW_OTHERS_PRIVATE_KEY]: show } });
      return true;
    } catch {
      this.write(!show);
      return false;
    }
  }
}
