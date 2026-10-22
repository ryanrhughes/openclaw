import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("home"),
  component: () =>
    import("./home-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-home-page></openclaw-home-page>`,
    })),
});
