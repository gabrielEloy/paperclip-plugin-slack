import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { runInProactiveSocketScope } from "../src/socket-mode.js";

describe("runInProactiveSocketScope", () => {
  it("does not retain the invocation that registered a long-lived callback", async () => {
    const invocation = new AsyncLocalStorage<string>();

    const observed = await invocation.run("expired-invocation", () =>
      runInProactiveSocketScope(async () => invocation.getStore()),
    );

    expect(observed).toBeUndefined();
  });
});
