import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createPromptRequest,
  createToolEvent,
  createChatFinalEvent,
} from "./translator.bridge-test-helpers.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";
import { AcpTranslatorSubagents } from "./translator.subagents.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";
vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));
afterEach(() => vi.useRealTimers());

function observer(
  request: (method: string) => Promise<unknown> = vi.fn(async (_method: string) => ({
    ok: true,
  })),
) {
  const emit = vi.fn(async (_params: Parameters<AcpTranslatorSessionUpdates["emit"]>[0]) => {});
  const children = new AcpTranslatorSubagents(
    { request } as unknown as GatewayClient,
    { emit } as unknown as AcpTranslatorSessionUpdates,
    () => {},
  );
  children.rememberSpawn(
    "parent",
    "spawn",
    {
      sessionId: "parent",
      sessionKey: "parent",
      idempotencyKey: "parent-run",
    },
    { task: "Say OK" },
  );
  children.acceptSpawn("parent", "spawn", {
    status: "accepted",
    childSessionKey: "child",
    runId: "child-run",
  });
  const event = (stream: string, data: Record<string, unknown>, kind = "agent") =>
    children.handleEvent({
      event: kind,
      payload: { sessionKey: "child", stream, data },
    } as EventFrame);
  const metas = () =>
    emit.mock.calls.map(
      ([call]) =>
        (
          call as unknown as {
            update: { _meta: { openclaw: { subagent: Record<string, unknown> } } };
          }
        ).update._meta.openclaw.subagent,
    );
  return { children, emit, request, event, metas };
}

describe("ACP sparse child observations", () => {
  it("recovers a nested spawn from sparse child item events without duplicate rows", async () => {
    const args = { task: "Grandchild task", model: "kimi/k3" };
    const request = vi.fn(async (method: string) =>
      method === "sessions.get"
        ? {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "toolCall", id: "nested", name: "sessions_spawn", arguments: args },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "nested",
                toolName: "sessions_spawn",
                details: {
                  status: "accepted",
                  childSessionKey: "grandchild",
                  resolvedModel: "kimi/k3",
                },
              },
            ],
          }
        : { ok: true },
    );
    const s = observer(request);
    await s.children.handleEvent({
      event: "session.message",
      payload: {
        sessionKey: "child",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "nested", name: "sessions_spawn", arguments: args }],
        },
      },
    } as EventFrame);
    await s.event("item", {
      kind: "tool",
      name: "sessions_spawn",
      toolCallId: "nested",
      phase: "start",
    });
    await s.event("item", {
      kind: "tool",
      name: "sessions_spawn",
      toolCallId: "nested",
      phase: "end",
      status: "completed",
    });
    await s.event("item", {
      kind: "tool",
      name: "sessions_spawn",
      toolCallId: "nested",
      phase: "end",
      status: "completed",
    });
    const nested = s.emit.mock.calls
      .map(([call]) => call.update)
      .filter(
        (u) =>
          (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
          u.toolCallId === "nested",
      );
    expect(nested.filter((u) => u.sessionUpdate === "tool_call")).toHaveLength(1);
    expect(nested).toContainEqual(
      expect.objectContaining({
        _meta: {
          openclaw: {
            toolName: "sessions_spawn",
            subagentId: "child",
            subagent: expect.objectContaining({
              id: "grandchild",
              parentId: "child",
              goal: "Grandchild task",
            }),
          },
        },
      }),
    );
    await s.children.shutdown();
  });
  it("revokes new child admission before awaiting shutdown cleanup", async () => {
    let release!: () => void;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.abort") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true };
    });
    const s = observer(request);
    const shutdown = s.children.shutdown();
    await Promise.resolve();
    s.children.rememberSpawn("parent", "late", {
      sessionId: "parent",
      sessionKey: "parent",
      idempotencyKey: "run",
    });
    expect(
      s.children.acceptSpawn("parent", "late", {
        status: "accepted",
        childSessionKey: "late-child",
      }),
    ).toBeUndefined();
    release();
    await shutdown;
    expect(s.metas()).toEqual([expect.objectContaining({ event: "completed", status: "stopped" })]);
  });
  it("ignores streamed text and duplicate tools, coalesces meaningful changes to one recorded update per second", async () => {
    vi.useFakeTimers();
    const s = observer();
    for (const kind of ["agent", "chat", "session.message", "session.tool"]) {
      for (let i = 0; i < 20; i++) {
        await s.event("assistant", { delta: String(i) }, kind);
      }
    }
    expect(s.emit).not.toHaveBeenCalled();
    const start = { phase: "start", name: "read", toolCallId: "read-1" };
    await s.event("tool", start);
    await s.event("tool", start, "session.tool");
    await s.event("tool", { ...start, phase: "result" });
    await s.event("lifecycle", { phase: "start", model: "openai/gpt-5.4" });
    expect(s.metas()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.metas()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.metas()).toHaveLength(2);
    expect(s.metas().at(-1)).toMatchObject({ event: "progress", model: "openai/gpt-5.4" });
    expect(
      s.emit.mock.calls.every(([call]) => (call as unknown as { record: boolean }).record),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.metas()).toHaveLength(2);
    await s.children.shutdown();
  });
  it("backs off wait failures and reports lost tracking within a few minutes, without further retries", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "agent.wait") {
        throw new Error("disconnected");
      }
      return { ok: true };
    });
    const s = observer(request);
    s.children.observe("child");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter(([m]) => m === "agent.wait")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter(([m]) => m === "agent.wait")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(s.metas()).toEqual([
      expect.objectContaining({
        event: "completed",
        status: "failed",
        summary: expect.stringContaining("lost track"),
      }),
    ]);
    const attempts = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request.mock.calls).toHaveLength(attempts);
    await s.children.shutdown();
  });
  it("resets the continuous error budget after healthy polling timeouts", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "agent.wait" && Date.now() % 120_000 >= 30_000) {
        throw new Error("transient");
      }
      return method === "agent.wait" ? { status: "timeout" } : { ok: true };
    });
    vi.setSystemTime(0);
    const s = observer(request);
    s.children.observe("child");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.metas()).toEqual([]);
    await s.children.shutdown();
  });
  it("clears queued progress on close and still cleans up when delivery fails", async () => {
    vi.useFakeTimers();
    const s = observer();
    await s.event("tool", { phase: "start", name: "read", toolCallId: "t" });
    await s.event("tool", { phase: "result", name: "read", toolCallId: "t" });
    s.emit.mockRejectedValueOnce(new Error("closed transport"));
    await s.children.closeSession("parent");
    expect(s.request).toHaveBeenCalledWith(
      "sessions.messages.unsubscribe",
      { key: "child" },
      { timeoutMs: 5_000 },
    );
    const count = s.emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.emit.mock.calls).toHaveLength(count);
  });
});

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
  it.each(["cancel", "close", "shutdown"])(
    "%s ends all children after the parent returned, exactly once",
    async (action) => {
      const s = await setup();
      await s.spawn("parent", "spawn-1", "child");
      await s.spawn("child", "spawn-2", "grandchild");
      await s.agent.handleGatewayEvent(createChatFinalEvent("parent"));
      await s.prompt;
      if (action === "cancel") {
        await s.agent.cancel({ sessionId: "parent" });
        await s.agent.cancel({ sessionId: "parent" });
      } else if (action === "close") {
        await s.agent.closeSession({ sessionId: "parent" });
      } else {
        await s.agent.shutdown();
      }
      for (const id of ["child", "grandchild"]) {
        expect(s.request).toHaveBeenCalledWith(
          "sessions.abort",
          { key: id, clearQueued: true },
          { timeoutMs: 5_000 },
        );
        expect(s.metas().filter((meta) => meta.id === id && meta.event === "completed")).toEqual([
          expect.objectContaining({ status: "stopped" }),
        ]);
        expect(s.request).toHaveBeenCalledWith(
          "sessions.messages.unsubscribe",
          { key: id },
          { timeoutMs: 5_000 },
        );
        s.waits.get(id)!({ status: "ok", terminalReply: { disposition: "visible", text: "late" } });
      }
      await s.agent.shutdown();
      expect(s.metas().filter((meta) => meta.event === "completed")).toHaveLength(2);
    },
  );
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
        stream: "tool",
        data: { phase: "start", toolCallId: "read-1", name: "read" },
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
    expect(s.request).toHaveBeenCalledWith(
      "sessions.messages.subscribe",
      {
        key: "agent:main:subagent:child",
      },
      { timeoutMs: 5_000 },
    );
    await vi.waitFor(() =>
      expect(s.request).toHaveBeenCalledWith(
        "sessions.messages.unsubscribe",
        {
          key: "agent:main:subagent:child",
        },
        { timeoutMs: 5_000 },
      ),
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
    const calls = s.connection["__sessionUpdateMock"].mock.calls.map(([call]) => call);
    const nested = calls.filter(
      (call) => "toolCallId" in call.update && call.update.toolCallId === "spawn-2",
    );
    expect(nested).toHaveLength(2);
    for (const call of nested) {
      expect(call.update._meta?.openclaw).toMatchObject({ subagentId: "child" });
    }
    const rootStart = calls.find(
      (call) => call.update.sessionUpdate === "tool_call" && call.update.toolCallId === "spawn-1",
    );
    expect(rootStart?.update._meta?.openclaw).not.toHaveProperty("subagentId");
    expect(calls.every((call) => call.sessionId === "parent")).toBe(true);
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
