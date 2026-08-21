import { describe, expect, it, vi } from "vitest";
import { postMessage } from "../src/slack-api.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Slack direct-message delivery", () => {
  it("opens a writable DM before posting when configured with a user ID", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: { id: "D_TEST_DM" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channel: "D_TEST_DM", ts: "123.456" }));
    const ctx = { http: { fetch }, logger: { warn: vi.fn() } } as never;

    const result = await postMessage(ctx, "xoxb-test", "U_TEST_USER", { text: "hello" });

    expect(result).toMatchObject({ ok: true, channel: "D_TEST_DM", ts: "123.456" });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/conversations.open",
      expect.objectContaining({ body: JSON.stringify({ users: "U_TEST_USER" }) }),
    );
    const postBody = JSON.parse(fetch.mock.calls[1][1].body as string);
    expect(postBody.channel).toBe("D_TEST_DM");
  });

  it("posts directly when the configured destination is already a channel ID", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({ ok: true, channel: "C_TEST_CHANNEL", ts: "456.789" }),
    );
    const ctx = { http: { fetch }, logger: { warn: vi.fn() } } as never;

    await postMessage(ctx, "xoxb-test", "C_TEST_CHANNEL", { text: "hello" });

    expect(fetch).toHaveBeenCalledOnce();
    const postBody = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(postBody.channel).toBe("C_TEST_CHANNEL");
  });
});
