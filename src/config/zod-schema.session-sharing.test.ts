import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema sharing policy", () => {
  it("accepts the sharing mode gates and private default", () => {
    expect(
      SessionSchema.parse({
        sharing: {
          readOnly: false,
          suggest: true,
          drafts: true,
          defaultVisibility: "private",
        },
      }),
    ).toEqual({
      sharing: {
        readOnly: false,
        suggest: true,
        drafts: true,
        defaultVisibility: "private",
      },
    });
    expect(SessionSchema.parse({ sharing: { defaultVisibility: "shared" } })).toEqual({
      sharing: { defaultVisibility: "shared" },
    });
  });

  it("rejects additional sharing knobs", () => {
    expect(SessionSchema.safeParse({ sharing: { default: "draft" } }).success).toBe(false);
  });

  it("rejects a private default when drafts are disabled", () => {
    const result = SessionSchema.safeParse({
      sharing: { drafts: false, defaultVisibility: "private" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["sharing", "defaultVisibility"],
          message: 'defaultVisibility cannot be "private" when drafts are disabled',
        }),
      );
    }
  });
});
