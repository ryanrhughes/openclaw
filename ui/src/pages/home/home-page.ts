import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionMatchesVisibleSessionScope } from "../../lib/sessions/navigation.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import type {
  SessionListScope,
  SessionListSnapshot,
} from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { newSessionSearch } from "../new-session/location.ts";
import "../../styles/home.css";

const RECENT_SESSION_LIMIT = 20;

type HomeListBinding = {
  context: ApplicationContext;
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  selfId: string;
  agentId: string;
  observation?: ReturnType<ApplicationContext["sessions"]["observeList"]>;
  latest?: SessionListSnapshot;
  ready: boolean;
};

export function homeSessionsQuery(agentId: string): SessionListScope {
  return {
    source: "sessions-page",
    rowMode: "compact",
    agentId,
    involvingMe: true,
    limit: RECENT_SESSION_LIMIT,
    includeDerivedTitles: true,
    includeLastMessage: false,
    includeGlobal: false,
    includeUnknown: false,
    excludeSubagents: true,
    excludeCron: true,
    excludeSystem: true,
    excludeDock: true,
    archivedFilter: "active",
  };
}

class HomePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private snapshot: SessionListSnapshot | null = null;
  private binding?: HomeListBinding;
  private readonly subscriptions = new SubscriptionsController(this)
    .watchStore(() => this.context?.gateway)
    .watchStore(() => this.context?.agentSelection)
    .watchStore(() => this.context?.agents);

  override willUpdate() {
    this.bindList();
  }

  override disconnectedCallback() {
    this.binding?.observation?.dispose();
    this.binding = undefined;
    this.snapshot = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private isCurrent(binding: HomeListBinding): boolean {
    const context = this.context;
    return (
      this.isConnected &&
      this.binding === binding &&
      context === binding.context &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === binding.client &&
      context.gateway.snapshot.selfUser?.id.trim() === binding.selfId &&
      resolveSessionNavigationAgentId(context) === binding.agentId
    );
  }

  private bindList(): void {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    const selfId = gateway?.selfUser?.id.trim();
    const agentId = context ? resolveSessionNavigationAgentId(context) : "";
    const current = this.binding;
    if (current && this.isCurrent(current)) {
      return;
    }
    current?.observation?.dispose();
    this.binding = undefined;
    this.snapshot = null;
    // An unidentified connection must never fall back to its full visible roster.
    if (
      !context ||
      !this.isConnected ||
      gateway?.phase !== "connected" ||
      !gateway.client ||
      !selfId
    ) {
      return;
    }
    const binding: HomeListBinding = {
      context,
      client: gateway.client,
      selfId,
      agentId,
      ready: false,
    };
    this.binding = binding;
    binding.observation = context.sessions.observeList(homeSessionsQuery(agentId), (snapshot) => {
      if (!this.isCurrent(binding)) {
        return;
      }
      binding.latest = snapshot;
      if (binding.ready) {
        this.snapshot = snapshot;
      }
    });
    // The query's first replay can be retained from another identity on this
    // connection. Publish it only after an explicit read for this binding settles.
    void this.refresh(binding);
  }

  private async refresh(binding = this.binding): Promise<void> {
    if (!binding?.observation || !this.isCurrent(binding)) {
      return;
    }
    try {
      await binding.observation.refresh();
    } catch {
      // The managed-list owner publishes the actionable read error.
    }
    if (this.isCurrent(binding)) {
      binding.ready = true;
      this.snapshot = binding.latest ?? null;
    }
  }

  private renderSession(row: GatewaySessionRow, context: ApplicationContext, agentId: string) {
    const face = resolveSessionPreferredFace(row);
    const target = sessionNavigationTarget({
      face,
      sessionKey: row.key,
      fallbackAgentId: row.agentId ?? agentId,
      row,
      basePath: context.basePath,
      exactKey: true,
    });
    const isPrivate = row.visibility === "draft";
    return html`<li>
      <a
        class="home-page__session"
        href=${target.href}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          selectApplicationSession({
            selection: context.agentSelection,
            gateway: context.gateway,
            sessionKey: row.key,
            agentId: row.agentId ?? agentId,
          });
          context.navigate(face, target.options);
        }}
      >
        <span class="home-page__session-icon" aria-hidden="true">${icons.messageSquare}</span>
        <span class="home-page__session-title">${resolveSessionDisplayName(row.key, row)}</span>
        <span class="home-page__session-meta">
          <span class="home-page__visibility">
            <span aria-hidden="true">${isPrivate ? icons.lock : icons.users}</span>
            ${t(isPrivate ? "homePage.private" : "homePage.shared")}
          </span>
          <span class="home-page__time">${formatRelativeTimestamp(row.updatedAt)}</span>
        </span>
        <span class="home-page__session-arrow" aria-hidden="true">${icons.arrowRight}</span>
      </a>
    </li>`;
  }

  private renderRecent(context: ApplicationContext) {
    const gateway = context.gateway.snapshot;
    if (gateway.phase !== "connected" || !gateway.client) {
      return html`<p class="home-page__status" role="status">${t("homePage.disconnected")}</p>`;
    }
    if (!gateway.selfUser?.id.trim()) {
      return html`<p class="home-page__status" role="status">
        ${t("homePage.identityUnavailable")}
      </p>`;
    }
    const snapshot = this.snapshot;
    if (snapshot?.error) {
      return html`<div class="home-page__status home-page__error" role="alert">
        <p>${t("homePage.loadError")}</p>
        <button class="btn btn--sm" @click=${() => void this.refresh()}>
          ${t("homePage.retry")}
        </button>
      </div>`;
    }
    if (!snapshot?.result) {
      return html`<p class="home-page__status" role="status">${t("homePage.loading")}</p>`;
    }
    const agentId = resolveSessionNavigationAgentId(context);
    const mainKey = buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: gateway.hello,
      }),
    });
    const rows = snapshot.result.sessions
      .filter(
        (row) =>
          row.isMain !== true &&
          !areUiSessionKeysEquivalent(row.key, mainKey) &&
          !isSubagentSessionKey(row.key) &&
          sessionMatchesVisibleSessionScope(row, {
            agentId,
            defaultAgentId: agentId,
            filterByAgent: true,
          }),
      )
      .slice(0, RECENT_SESSION_LIMIT);
    return rows.length
      ? html`<ul class="home-page__sessions">
          ${repeat(
            rows,
            (row) => row.key,
            (row) => this.renderSession(row, context, agentId),
          )}
        </ul>`
      : html`<div class="home-page__empty">
          <span class="home-page__empty-icon" aria-hidden="true">${icons.messageSquarePlus}</span>
          <h3>${t("homePage.emptyTitle")}</h3>
          <p>${t("homePage.emptyDescription")}</p>
        </div>`;
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const search = newSessionSearch(resolveSessionNavigationAgentId(context));
    return html`
      <div class="home-page__header">
        ${renderSettingsPageHeader({ title: t("homePage.title"), subtitle: t("homePage.subtitle") })}
      </div>
      <section class="home-page" aria-label=${t("homePage.title")}>
        <div class="home-page__start">
          <a
            class="btn primary home-page__new"
            href=${`${pathForRoute("new-session", context.basePath)}${search}`}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                context.navigate("new-session", { search });
              }
            }}
          >
            <span aria-hidden="true">${icons.messageSquarePlus}</span>
            ${t("homePage.newSession")}
          </a>
          <p>${t("homePage.privateByDefault")}</p>
        </div>
        <section class="home-page__recent" aria-labelledby="home-recent-title">
          <div class="home-page__recent-header">
            <h2 id="home-recent-title">${t("homePage.recentTitle")}</h2>
            <p>${t("homePage.recentDescription")}</p>
          </div>
          ${this.renderRecent(context)}
        </section>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-home-page")) {
  customElements.define("openclaw-home-page", HomePage);
}
