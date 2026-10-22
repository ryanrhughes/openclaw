import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Home personal landing page",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const now = Date.parse("2026-10-21T12:00:00Z");
const privateSession = createControlUiSessionRow(
  "agent:writer:release-plan",
  "Release plan",
  now - 5 * 60_000,
  { visibility: "draft", agentId: "writer" },
);
const sharedSession = createControlUiSessionRow(
  "agent:writer:team-planning",
  "Team planning",
  now - 25 * 60_000,
  { visibility: "shared", agentId: "writer" },
);
const mainSession = createControlUiSessionRow(
  "agent:writer:main",
  "Shared main conversation",
  now,
  { isMain: true, agentId: "writer" },
);
const anotherPersonsSession = createControlUiSessionRow(
  "agent:writer:another-person",
  "Another person's private work",
  now - 60_000,
  { visibility: "draft", agentId: "writer" },
);
const personalRows = [mainSession, privateSession, sharedSession];
const broadRows = [...personalRows, anotherPersonsSession];
const listResult = (sessions: typeof broadRows) => ({
  ts: now,
  path: "",
  count: sessions.length,
  defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
  sessions,
});
const scopedResponses = (personalResponse: unknown) => ({
  cases: [
    { match: { involvingMe: true }, response: personalResponse },
    { match: {}, response: listResult(broadRows) },
  ],
});

async function captureHome(
  page: Page,
  artifactDir: string,
  name: string,
  content: string,
  viewport = { width: 1440, height: 900 },
) {
  const frame = await takeControlUiScreenshotFrame(
    page,
    page.locator(".home-page"),
    [page.locator(".home-page__header .page-title"), page.locator(content)],
    { viewport, animations: "disabled" },
  );
  await writeFile(path.join(artifactDir, name), frame.png);
}

suite.define(() => {
  it("opens personal Home without loading shared chat, resumes work, and starts a session", async () => {
    const artifactDir = createControlUiE2eArtifactDir("home-landing");
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(now));
        const gateway = await installMockGateway(page, {
          defaultAgentId: "writer",
          assistantAgentId: "writer",
          sessionKey: "agent:writer:main",
          mainSessionKey: "agent:writer:main",
          sessions: broadRows,
          presenceUsers: [{ id: "profile-ada", name: "Ada", self: true }],
          historyMessages: [{ role: "assistant", content: "Ready to continue this session." }],
          methodResponses: {
            "agents.list": {
              defaultId: "writer",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "writer", name: "Writer" }],
            },
            "sessions.list": scopedResponses(listResult(personalRows)),
          },
        });
        await page.goto(suite.server.baseUrl);
        const home = page.locator("openclaw-home-page");
        await home.getByRole("heading", { name: "Home", exact: true }).waitFor();
        await home.getByText("Release plan", { exact: true }).waitFor();
        const personalRequest = await gateway.waitForRequest("sessions.list", {
          match: { involvingMe: true, agentId: "writer" },
        });
        expect(personalRequest.params).toMatchObject({
          limit: 20,
          excludeSubagents: true,
          excludeCron: true,
          excludeSystem: true,
          excludeDock: true,
        });
        expect(new URL(page.url()).pathname).toBe("/");
        expect(await gateway.getRequests("chat.history")).toHaveLength(0);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        expect(await home.locator(".home-page__session-title").allTextContents()).toEqual([
          "Release plan",
          "Team planning",
        ]);
        expect(
          (await home.locator(".home-page__visibility").allTextContents()).map((value) =>
            value.trim(),
          ),
        ).toEqual(["Private", "Shared"]);
        expect(await home.getByText("Shared main conversation", { exact: true }).count()).toBe(0);
        expect(await home.getByText("Another person's private work", { exact: true }).count()).toBe(
          0,
        );
        await captureHome(page, artifactDir, "01-home-desktop.png", ".home-page__sessions");
        await captureHome(page, artifactDir, "02-home-mobile.png", ".home-page__sessions", {
          width: 390,
          height: 844,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);

        await page.setViewportSize({ width: 1440, height: 900 });
        await home.getByRole("link", { name: /Release plan/ }).click();
        await page.waitForURL((url) => url.pathname === "/chat/writer/release-plan");
        await page.locator("openclaw-chat-page").waitFor();
        await gateway.waitForRequest("chat.startup", { match: { sessionKey: privateSession.key } });
        await page.locator("openclaw-app-sidebar .nav-item--home").click();
        await page.waitForURL((url) => url.pathname === "/home");
        await home.getByText("Release plan", { exact: true }).waitFor();
        await home.getByRole("link", { name: "New session", exact: true }).click();
        await page.waitForURL(
          (url) => url.pathname === "/new" && url.searchParams.get("agent") === "writer",
        );
        await page.locator("openclaw-new-session-page").waitFor();

        await gateway.setMethodResponse(
          "sessions.list",
          scopedResponses({
            __mockError: {
              code: "UNAVAILABLE",
              message: "Recent sessions are temporarily unavailable.",
            },
          }),
        );
        await page.locator("openclaw-app-sidebar .nav-item--home").click();
        await home.getByRole("alert").waitFor();
        await captureHome(page, artifactDir, "03-home-retry.png", ".home-page__error");
        await gateway.setMethodResponse("sessions.list", scopedResponses(listResult([])));
        await home.getByRole("button", { name: "Try again", exact: true }).click();
        await home
          .getByRole("heading", { name: "Your next session starts here", exact: true })
          .waitFor();
        await captureHome(page, artifactDir, "04-home-empty.png", ".home-page__empty");
      },
    );
  });
});
