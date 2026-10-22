/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAppSidebarHomeRow } from "./app-sidebar-render.ts";

afterEach(() => document.body.replaceChildren());

describe("personal Home navigation", () => {
  it.each(["home", "chat"] as const)(
    "opens Home without selecting a conversation from the %s page",
    (activeRouteId) => {
      const onNavigate = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      render(renderAppSidebarHomeRow({ activeRouteId, basePath: "/oodle", onNavigate }), container);
      const home = container.querySelector<HTMLAnchorElement>(".nav-item--home")!;
      expect(home.getAttribute("href")).toBe("/oodle/home");
      expect(home.getAttribute("aria-current")).toBe(activeRouteId === "home" ? "page" : null);
      expect(home.textContent?.trim()).toBe("Home");
      home.click();
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("home");

      onNavigate.mockClear();
      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      home.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
      expect(onNavigate).not.toHaveBeenCalled();
    },
  );
});
