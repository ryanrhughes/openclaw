import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { homeSessionsQuery } from "./home-page.ts";

type HomePageElement = HTMLElement & { updateComplete: Promise<boolean> };

const privateRow: GatewaySessionRow = {
  key: "agent:main:release-plan",
  kind: "direct",
  updatedAt: 5,
  displayName: "Release plan",
  visibility: "draft",
};
const joinedRow: GatewaySessionRow = {
  key: "agent:main:team-planning",
  kind: "direct",
  updatedAt: 4,
  displayName: "Team planning",
  visibility: "shared",
  boardFace: "dashboard",
};
const otherPrivateRow: GatewaySessionRow = {
  key: "agent:main:someone-elses-work",
  kind: "direct",
  updatedAt: 6,
  displayName: "Someone else’s private work",
  visibility: "draft",
};

function fixture(
  options: {
    selfId?: string | null;
    read?: (params: Record<string, unknown>) => Promise<SessionsListResult>;
  } = {},
) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method !== "sessions.list") {
      return {};
    }
    return options.read
      ? options.read(params ?? {})
      : sessionsResult(params?.involvingMe ? [privateRow, joinedRow] : [otherPrivateRow], 1);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gatewayHarness = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser: options.selfId === null ? null : { id: options.selfId ?? "profile-ada" },
  });
  const gateway = gatewayHarness.gateway;
  const setSessionKey = vi.fn();
  Object.assign(gateway, { setSessionKey });
  const agents = {
    state: {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [{ id: "main" }, { id: "writer" }],
      },
    },
    subscribe: () => () => undefined,
  };
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  const sessions = createSessionCapability(gateway, agentSelection);
  onTestFinished(() => {
    sessions.dispose();
    agentSelection.dispose();
  });
  const navigate = vi.fn();
  const context = {
    basePath: "/oodle",
    gateway,
    agents,
    agentSelection,
    sessions,
    navigate,
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-home-page") as HomePageElement;
  const mount = async () => {
    provider.append(page);
    document.body.append(provider);
    await page.updateComplete;
  };
  const settle = async () => {
    await sessions.refreshList(homeSessionsQuery(agentSelection.state.selectedId ?? "main"));
    await page.updateComplete;
    await page.updateComplete;
  };
  const publish = (patch: Partial<ApplicationGatewaySnapshot>) =>
    gatewayHarness.publish({ ...gateway.snapshot, ...patch });
  return {
    page,
    mount,
    settle,
    sessions,
    request,
    navigate,
    setSessionKey,
    agentSelection,
    publish,
  };
}

describe("Home landing page", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reads only the signed-in person's recent work through the production session owner", async () => {
    const h = fixture();
    // Administrators can already hold other people's rows in the primary roster.
    await h.sessions.refreshList();
    await h.mount();
    await h.settle();

    const calls = h.request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(calls.at(-1)?.[1]).toEqual({
      source: "sessions-page",
      rowMode: "compact",
      agentId: "main",
      involvingMe: true,
      limit: 20,
      includeDerivedTitles: true,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      excludeDock: true,
    });
    expect(h.page.textContent).toContain("Release plan");
    expect(h.page.textContent).toContain("Team planning");
    expect(h.page.textContent).not.toContain("Someone else’s private work");
    expect(
      [...h.page.querySelectorAll(".home-page__visibility")].map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual(["Private", "Shared"]);
  });

  it("never reads or replays the broad roster without a signed-in identity", async () => {
    const h = fixture({ selfId: null });
    await h.sessions.refreshList();
    const readsBeforeHome = h.request.mock.calls.length;
    await h.mount();
    await h.page.updateComplete;

    expect(h.request.mock.calls).toHaveLength(readsBeforeHome);
    expect(h.page.textContent).toContain("Sign in with a user profile");
    expect(h.page.textContent).not.toContain("Someone else’s private work");
    expect(h.page.querySelectorAll(".home-page__session")).toHaveLength(0);
  });

  it("uses canonical session links and preserves native modified-click behavior", async () => {
    const h = fixture();
    await h.mount();
    await h.settle();
    const newLink = h.page.querySelector<HTMLAnchorElement>(".home-page__new")!;
    expect(newLink.getAttribute("href")).toBe("/oodle/new?agent=main");
    newLink.click();
    expect(h.navigate).toHaveBeenLastCalledWith("new-session", { search: "?agent=main" });

    const links = h.page.querySelectorAll<HTMLAnchorElement>(".home-page__session");
    expect(links[0]?.getAttribute("href")).toBe("/oodle/chat/main/release-plan");
    expect(links[1]?.getAttribute("href")).toBe("/oodle/dashboard/main/team-planning");
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    const nativeActivation = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false);
      // JSDOM has no native document navigation; consume it after the page lets it through.
      event.preventDefault();
    });
    h.page.addEventListener("click", nativeActivation, { once: true });
    links[1]!.dispatchEvent(modified);
    expect(nativeActivation).toHaveBeenCalledOnce();
    expect(h.navigate).toHaveBeenCalledTimes(1);

    links[1]!.click();
    expect(h.setSessionKey).toHaveBeenCalledWith("agent:main:team-planning");
    expect(h.navigate).toHaveBeenLastCalledWith("dashboard", {
      pathname: "/oodle/dashboard/main/team-planning",
    });
  });

  it("moves the personal query and New session target with the selected agent", async () => {
    const h = fixture({
      read: async (params) =>
        sessionsResult(
          [
            params.agentId === "writer"
              ? {
                  key: "agent:writer:article",
                  kind: "direct",
                  updatedAt: 2,
                  displayName: "Article draft",
                }
              : privateRow,
          ],
          1,
        ),
    });
    await h.mount();
    await h.settle();
    h.agentSelection.set("writer");
    await h.page.updateComplete;
    await h.settle();

    expect(h.request.mock.calls.at(-1)?.[1]).toMatchObject({
      agentId: "writer",
      involvingMe: true,
    });
    expect(h.page.textContent).toContain("Article draft");
    expect(h.page.textContent).not.toContain("Release plan");
    expect(h.page.querySelector(".home-page__new")?.getAttribute("href")).toBe(
      "/oodle/new?agent=writer",
    );
  });

  it("keeps the agent's shared main conversation and internal rows off Home", async () => {
    const h = fixture({
      read: async () =>
        sessionsResult(
          [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 9,
              displayName: "Main conversation",
            },
            {
              key: "agent:main:subagent:helper",
              kind: "direct",
              updatedAt: 8,
              displayName: "Helper",
            },
            {
              key: "agent:main:cron:report",
              kind: "direct",
              updatedAt: 7,
              displayName: "Automation",
            },
            { key: "agent:main:archived", kind: "direct", updatedAt: 6, archived: true },
            privateRow,
          ],
          1,
        ),
    });
    await h.mount();
    await h.settle();
    expect(
      [...h.page.querySelectorAll(".home-page__session-title")].map((row) => row.textContent),
    ).toEqual(["Release plan"]);
  });

  it("clears the old person's rows while their replacement identity is loading", async () => {
    const first = deferred<SessionsListResult>();
    const replacement = deferred<SessionsListResult>();
    const replacementStarted = deferred();
    let person = "ada";
    const h = fixture({
      read: async (params) => {
        if (!params.involvingMe) {
          return sessionsResult([otherPrivateRow], 1);
        }
        if (person === "ada") {
          return first.promise;
        }
        replacementStarted.resolve();
        return replacement.promise;
      },
    });
    await h.mount();
    first.resolve(sessionsResult([privateRow], 1));
    await h.settle();
    expect(h.page.textContent).toContain("Release plan");

    person = "bea";
    h.publish({ selfUser: { id: "profile-bea" } });
    await h.page.updateComplete;
    await replacementStarted.promise;
    expect(h.page.textContent).not.toContain("Release plan");
    expect(h.page.textContent).toContain("Loading your sessions");
    replacement.resolve(sessionsResult([joinedRow], 2));
    await h.settle();
    expect(h.page.textContent).toContain("Team planning");
    expect(h.page.textContent).not.toContain("Release plan");
  });

  it("offers recovery after a failed read and shows empty and disconnected states", async () => {
    let failed = true;
    const h = fixture({
      read: async () => {
        if (failed) {
          throw new Error("Session list unavailable");
        }
        return sessionsResult([], 1);
      },
    });
    await h.mount();
    await h.settle();
    expect(h.page.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load your recent sessions.",
    );
    failed = false;
    h.page.querySelector<HTMLButtonElement>(".home-page__error button")!.click();
    await h.settle();
    expect(h.page.textContent).toContain("Your next session starts here");

    h.publish({ phase: "reconnecting" });
    await h.page.updateComplete;
    expect(h.page.textContent).toContain("Connect to your Gateway");
    expect(h.page.querySelectorAll(".home-page__session")).toHaveLength(0);
  });
});
