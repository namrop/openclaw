/** Tests Gateway errorKind to ACP refusal/error mapping. */
import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  createSessionAgentHarness,
  DEFAULT_SESSION_KEY,
  observeSettlement,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";

describe("acp translator errorKind mapping", () => {
  it("maps errorKind: refusal to stopReason: refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "refusal",
        errorMessage: "I cannot fulfill this request.",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "refusal" });
  });

  it.each(["timeout", "rate_limit", "overloaded", "unknown", undefined])(
    "surfaces %s failures as ACP request errors, not successful end_turn",
    async (errorKind) => {
      const { agent, promptPromise, runId } = await createPendingPromptHarness();
      const errorMessage = "All models failed: provider subscription unavailable";
      const rejection = expect(promptPromise).rejects.toBeInstanceOf(RequestError);

      await agent.handleGatewayEvent(
        createChatEvent({
          runId,
          sessionKey: DEFAULT_SESSION_KEY,
          seq: 1,
          state: "error",
          errorKind,
          errorMessage,
        }),
      );

      await rejection;
      await expect(promptPromise).rejects.toMatchObject({ code: -32603, message: errorMessage });
    },
  );

  it("waits through failed attempts, then rejects once after fallback exhaustion and allows retry", async () => {
    const request = vi.fn(async () => ({})) as GatewayClient["request"];
    const { agent, sessionId, sessionStore } = createSessionAgentHarness(request);
    const promptPromise = promptAgent(agent, sessionId);
    const settlement = observeSettlement(promptPromise);
    const runId = sessionStore.getSession(sessionId)!.activeRunId!;
    const errorMessage = "All models failed (2): primary unavailable | fallback unavailable";

    for (let attempt = 0; attempt < 4; attempt++) {
      await agent.handleGatewayEvent({
        type: "event",
        event: "agent",
        payload: {
          runId,
          sessionKey: DEFAULT_SESSION_KEY,
          stream: "lifecycle",
          data: { phase: "finishing", error: "provider unavailable" },
        },
      });
      expect(settlement).not.toHaveBeenCalled();
    }
    const errorEvent = createChatEvent({
      runId,
      sessionKey: DEFAULT_SESSION_KEY,
      seq: 18,
      state: "error",
      errorMessage,
    });
    await agent.handleGatewayEvent(errorEvent);
    await expect(promptPromise).rejects.toMatchObject({ code: -32603, message: errorMessage });
    expect(sessionStore.getSession(sessionId)?.activeRunId).toBeNull();
    expect(settlement).toHaveBeenCalledTimes(1);

    const retry = promptAgent(agent, sessionId, "retry");
    const retrySettlement = observeSettlement(retry);
    const retryRunId = sessionStore.getSession(sessionId)!.activeRunId!;
    await agent.handleGatewayEvent(errorEvent);
    expect(retrySettlement).not.toHaveBeenCalled();
    await agent.handleGatewayEvent(
      createChatEvent({
        runId: retryRunId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "final",
        message: { content: [{ type: "text", text: "OK" }] },
      }),
    );
    await expect(retry).resolves.toEqual({ stopReason: "end_turn" });
  });
});
