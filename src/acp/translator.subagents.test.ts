import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createPromptRequest,
  createToolEvent,
  createChatFinalEvent,
} from "./translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";
vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

async function setup() {
  const connection = createAcpConnection();
  const waits = new Map<string, (value: unknown) => void>();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      return new Promise(() => {});
    }
    if (method === "agent.wait") {
      return new Promise((resolve) => {
        waits.set(String(params?.runId), resolve);
      });
    }
    if (method === "sessions.list") {
      return {
        defaults: {},
        sessions: [{ key: "parent", modelProvider: "openai", model: "gpt-5.4" }],
      };
    }
    return { ok: true };
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore: createInMemorySessionStore() },
  );
  await agent.loadSession(createLoadSessionRequest("parent"));
  connection["__sessionUpdateMock"].mockClear();
  const prompt = agent.prompt(createPromptRequest("parent", "Delegate tiny task"));
  const spawn = async (parent: string, id: string, child: string, run = child) => {
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: parent,
        phase: "start",
        toolCallId: id,
        name: "sessions_spawn",
        args: { task: "Say OK" },
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: parent,
        phase: "result",
        toolCallId: id,
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            childSessionKey: child,
            runId: run,
            resolvedModel: "openai/gpt-5.4",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(waits.has(run)).toBe(true));
  };
  const metas = (): Array<Record<string, unknown>> =>
    connection["__sessionUpdateMock"].mock.calls.flatMap(([call]) => {
      const meta = call.update._meta?.openclaw as
        | { subagent?: Record<string, unknown> }
        | undefined;
      return meta?.subagent
        ? [
            {
              toolCallId: "toolCallId" in call.update ? call.update.toolCallId : null,
              ...meta.subagent,
            },
          ]
        : [];
    });
  return { agent, request, connection, waits, prompt, spawn, metas };
}

describe("ACP child lifecycle", () => {
  it("reports spawn, progress, and canonical completion even after the parent prompt and spawning tool ended", async () => {
    const s = await setup();
    await s.spawn("parent", "spawn-1", "agent:main:subagent:child");
    expect(s.metas()).toContainEqual({
      toolCallId: "spawn-1",
      id: "agent:main:subagent:child",
      parentId: null,
      event: "started",
      goal: "Say OK",
      model: "openai/gpt-5.4",
    });
    await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
    await s.prompt;
    await s.agent.handleGatewayEvent({
      event: "agent",
      payload: {
        sessionKey: "agent:main:subagent:child",
        stream: "assistant",
        data: { delta: "Working" },
      },
    } as EventFrame);
    expect(s.metas().at(-1)).toMatchObject({ toolCallId: "spawn-1", event: "progress" });
    s.waits.get("agent:main:subagent:child")!({
      status: "ok",
      endedAt: 123,
      terminalReply: { disposition: "visible", text: "OK" },
    });
    await vi.waitFor(() =>
      expect(s.metas().at(-1)).toMatchObject({
        toolCallId: "spawn-1",
        event: "completed",
        status: "completed",
        summary: "OK",
      }),
    );
    expect(s.request).toHaveBeenCalledWith("sessions.messages.subscribe", {
      key: "agent:main:subagent:child",
    });
    await vi.waitFor(() =>
      expect(s.request).toHaveBeenCalledWith("sessions.messages.unsubscribe", {
        key: "agent:main:subagent:child",
      }),
    );
    await s.agent.shutdown();
  });
  it("routes nested spawns to the root ACP session and retains the parent's child id", async () => {
    const s = await setup();
    await s.spawn("parent", "spawn-1", "child");
    await s.spawn("child", "spawn-2", "grandchild");
    expect(s.metas()).toContainEqual(
      expect.objectContaining({
        toolCallId: "spawn-2",
        id: "grandchild",
        parentId: "child",
        event: "started",
      }),
    );
    expect(
      s.connection["__sessionUpdateMock"].mock.calls.every(([call]) => call.sessionId === "parent"),
    ).toBe(true);
    await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
    await s.prompt;
    await s.agent.shutdown();
  });
  it.each([
    { status: "error", stopReason: "error", expected: "failed" },
    { status: "timeout", stopReason: "rpc", expected: "stopped" },
    { status: "timeout", stopReason: "timeout", expected: "failed" },
  ])(
    "maps terminal $stopReason to $expected and bounds summary",
    async ({ status, stopReason, expected }) => {
      const s = await setup();
      await s.spawn("parent", "spawn-1", "child");
      s.waits.get("child")!({
        status,
        stopReason,
        endedAt: 42,
        terminalReply: { disposition: "visible", text: "X".repeat(21000) },
      });
      await vi.waitFor(() =>
        expect(s.metas().at(-1)).toMatchObject({
          event: "completed",
          status: expected,
          summary: "X".repeat(20000),
        }),
      );
      await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
      await s.prompt;
      await s.agent.shutdown();
    },
  );
  it("does not claim a child started when the spawn was rejected", async () => {
    const s = await setup();
    await s.agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "parent",
        phase: "start",
        toolCallId: "spawn-1",
        name: "sessions_spawn",
        args: { task: "Say OK" },
      }),
    );
    await s.agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "parent",
        phase: "result",
        toolCallId: "spawn-1",
        name: "sessions_spawn",
        result: { details: { status: "forbidden", error: "no" } },
      }),
    );
    expect(s.metas()).toEqual([]);
    expect(s.request.mock.calls.some(([method]) => method === "agent.wait")).toBe(false);
    await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
    await s.prompt;
    await s.agent.shutdown();
  });
  it("does not confuse a wait timeout with a child's terminal timeout", async () => {
    const s = await setup();
    await s.spawn("parent", "spawn-1", "child");
    s.waits.get("child")!({ status: "timeout" });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(s.metas().some((meta) => meta.event === "completed")).toBe(false);
    await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
    await s.prompt;
    await s.agent.shutdown();
  });
});
