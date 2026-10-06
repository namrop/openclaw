/** Child session observers outlive the parent's prompt and completed spawn tool. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { extractStoredAssistantText } from "../agents/tools/chat-history-text.js";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export type AcpSubagentMeta = {
  id: string;
  parentId: string | null;
  event: "started" | "progress" | "completed";
  goal: string;
  model: string | null;
  status?: "completed" | "failed" | "stopped";
  summary?: string;
  activity?: string;
};
type Route = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  idempotencyKey: string;
};
type Child = {
  route: Route;
  toolCallId: string;
  runId?: string;
  meta: AcpSubagentMeta;
  timer?: ReturnType<typeof setTimeout>;
  progressTimer?: ReturnType<typeof setTimeout>;
  lastProgressAt?: number;
  lastTool?: string;
  lifecyclePhase?: string;
  observing?: boolean;
  finishing?: Promise<void>;
  waitErrorSince?: number;
  waitErrors: number;
  spawnStarts: Set<string>;
  spawnEnds: Set<string>;
};
type Spawn = { route: Route; args?: Record<string, unknown>; parentId: string | null };

const PROGRESS_INTERVAL_MS = 1_000;
const WAIT_ERROR_BUDGET_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;

export class AcpTranslatorSubagents {
  private readonly children = new Map<string, Child>();
  private readonly spawns = new Map<string, Spawn>();
  private stopped = false;
  private draining = false;
  constructor(
    private readonly gateway: GatewayClient,
    private readonly updates: AcpTranslatorSessionUpdates,
    private readonly log: (msg: string) => void,
  ) {}

  rememberSpawn(
    sessionKey: string,
    toolCallId: string,
    route: Route,
    args?: Record<string, unknown>,
    parentId: string | null = null,
  ): void {
    if (!this.stopped && !this.draining) {
      this.spawns.set(`${sessionKey}\0${toolCallId}`, { route, args, parentId });
    }
  }
  acceptSpawn(
    sessionKey: string,
    toolCallId: string,
    result: unknown,
  ): AcpSubagentMeta | undefined {
    const key = `${sessionKey}\0${toolCallId}`;
    const spawn = this.spawns.get(key);
    this.spawns.delete(key);
    const raw = asOptionalRecord(result);
    const details = asOptionalRecord(raw?.details) ?? raw;
    if (
      this.stopped ||
      this.draining ||
      !spawn ||
      details?.status !== "accepted" ||
      typeof details.childSessionKey !== "string"
    ) {
      return undefined;
    }
    const id = details.childSessionKey;
    if (this.children.has(id)) {
      return undefined;
    }
    const meta: AcpSubagentMeta = {
      id,
      parentId: spawn.parentId,
      event: "started",
      goal: typeof spawn.args?.task === "string" ? spawn.args.task : "",
      // The accepted result is resolved by the child planner; do not claim the parent's model.
      model:
        typeof details.resolvedModel === "string" && details.resolvedModel.includes("/")
          ? details.resolvedModel
          : null,
    };
    this.children.set(id, {
      route: spawn.route,
      toolCallId,
      meta,
      runId: typeof details.runId === "string" ? details.runId : undefined,
      waitErrors: 0,
      spawnStarts: new Set(),
      spawnEnds: new Set(),
    });
    return meta;
  }
  observe(id: string): void {
    const child = this.children.get(id);
    if (child && this.active(child) && !child.observing) {
      child.observing = true;
      void this.monitor(child).catch((err) => this.log(`child observation failed: ${String(err)}`));
    }
  }
  private active(child: Child): boolean {
    return (
      !this.stopped &&
      !this.draining &&
      !child.finishing &&
      this.children.get(child.meta.id) === child
    );
  }
  private async emit(child: Child, meta: AcpSubagentMeta): Promise<void> {
    if (this.stopped || this.children.get(child.meta.id) !== child) {
      return;
    }
    await this.updates.emit({
      ...child.route,
      runId: child.route.idempotencyKey,
      record: true,
      waitForDelivery: false,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: child.toolCallId,
        _meta: {
          openclaw: {
            toolName: "sessions_spawn",
            ...(meta.parentId ? { subagentId: meta.parentId } : {}),
            subagent: { ...meta },
          },
        },
      },
    });
  }
  private async monitor(child: Child): Promise<void> {
    try {
      await this.gateway.request(
        "sessions.messages.subscribe",
        { key: child.meta.id },
        { timeoutMs: CLEANUP_TIMEOUT_MS },
      );
    } catch (err) {
      this.log(`child live subscription unavailable: ${String(err)}`);
    }
    if (!this.active(child)) {
      await this.unsubscribe(child);
      return;
    }
    if (child.runId) {
      await this.wait(child);
    }
  }
  private async wait(child: Child): Promise<void> {
    if (!this.active(child)) {
      return;
    }
    if (
      child.waitErrorSince !== undefined &&
      Date.now() - child.waitErrorSince >= WAIT_ERROR_BUDGET_MS
    ) {
      await this.finish(
        child,
        "failed",
        "The bridge lost track of this child after repeated gateway wait errors.",
      );
      return;
    }
    const waitStartedAt = Date.now();
    let retryMs = 1_000;
    try {
      const result = await this.gateway.request<{
        status?: string;
        endedAt?: number;
        stopReason?: string;
        pendingError?: boolean;
        yielded?: boolean;
        terminalReply?: { disposition?: string; text?: string };
      }>("agent.wait", { runId: child.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      if (!this.active(child)) {
        return;
      }
      child.waitErrorSince = undefined;
      child.waitErrors = 0;
      // A polling timeout, queued/yielded run or provisional retry error is not a child end.
      if (
        !result.pendingError &&
        !result.yielded &&
        (result.status === "ok" ||
          ((result.status === "error" || result.status === "timeout") &&
            typeof result.endedAt === "number"))
      ) {
        let summary =
          result.terminalReply?.disposition === "visible" ? (result.terminalReply.text ?? "") : "";
        if (!result.terminalReply) {
          const history = await this.gateway
            .request<{ messages?: unknown[] }>(
              "sessions.get",
              { key: child.meta.id, limit: 50 },
              { timeoutMs: CLEANUP_TIMEOUT_MS },
            )
            .catch(() => ({ messages: [] }));
          for (const message of (history.messages ?? []).toReversed()) {
            const text = extractStoredAssistantText(message);
            if (text) {
              summary = text;
              break;
            }
          }
        }
        const status =
          result.status === "ok"
            ? "completed"
            : ["rpc", "aborted", "killed", "restart", "stop"].includes(result.stopReason ?? "")
              ? "stopped"
              : "failed";
        await this.finish(child, status, summary);
        return;
      }
    } catch (err) {
      this.log(`child wait unavailable (not a child failure): ${String(err)}`);
      child.waitErrorSince ??= waitStartedAt;
      child.waitErrors += 1;
      retryMs = Math.min(
        30_000,
        1_000 * 2 ** Math.min(child.waitErrors - 1, 5),
        Math.max(0, WAIT_ERROR_BUDGET_MS - (Date.now() - child.waitErrorSince)),
      );
    }
    if (this.active(child)) {
      child.timer = setTimeout(() => {
        child.timer = undefined;
        void this.wait(child).catch((err) => this.log(`child wait cleanup failed: ${String(err)}`));
      }, retryMs);
      child.timer.unref();
    }
  }
  private async unsubscribe(child: Child): Promise<void> {
    await this.gateway
      .request(
        "sessions.messages.unsubscribe",
        { key: child.meta.id },
        { timeoutMs: CLEANUP_TIMEOUT_MS },
      )
      .catch(() => {});
  }
  private finish(
    child: Child,
    status: NonNullable<AcpSubagentMeta["status"]>,
    summary: string,
    abort = false,
  ): Promise<void> {
    if (child.finishing) {
      return child.finishing;
    }
    if (this.stopped || this.children.get(child.meta.id) !== child) {
      return Promise.resolve();
    }
    // Claim before any await: cancel, wait, and shutdown race, but only one owns the end.
    // Defer the body one microtask so the claim is installed before calling external code.
    child.finishing = Promise.resolve().then(async () => {
      let terminalSummary = summary;
      if (child.timer) {
        clearTimeout(child.timer);
      }
      if (child.progressTimer) {
        clearTimeout(child.progressTimer);
      }
      try {
        if (abort) {
          await this.gateway
            .request(
              "sessions.abort",
              { key: child.meta.id, clearQueued: true },
              { timeoutMs: CLEANUP_TIMEOUT_MS },
            )
            .catch((err) => {
              this.log(`child abort failed: ${String(err)}`);
              terminalSummary =
                "Child observation stopped; the gateway could not confirm cancellation.";
            });
        }
        await this.emit(child, {
          ...child.meta,
          event: "completed",
          status,
          summary: truncateUtf16Safe(terminalSummary, 20_000),
        });
      } catch (err) {
        this.log(`child terminal delivery failed: ${String(err)}`);
      } finally {
        this.children.delete(child.meta.id);
        await this.unsubscribe(child);
      }
    });
    return child.finishing;
  }
  private async progress(child: Child): Promise<void> {
    if (!this.active(child)) {
      return;
    }
    const delay =
      child.lastProgressAt === undefined
        ? 0
        : Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - child.lastProgressAt));
    if (delay > 0) {
      if (!child.progressTimer) {
        child.progressTimer = setTimeout(() => {
          child.progressTimer = undefined;
          void this.progress(child).catch((err) =>
            this.log(`child progress failed: ${String(err)}`),
          );
        }, delay);
        child.progressTimer.unref();
      }
      return;
    }
    if (child.progressTimer) {
      clearTimeout(child.progressTimer);
    }
    child.progressTimer = undefined;
    child.lastProgressAt = Date.now();
    await this.emit(child, { ...child.meta, event: "progress" });
  }
  async handleEvent(evt: EventFrame): Promise<boolean> {
    const payload = asOptionalRecord(evt.payload);
    const child =
      typeof payload?.sessionKey === "string" ? this.children.get(payload.sessionKey) : undefined;
    if (!child || !this.active(child)) {
      return false;
    }
    const data = asOptionalRecord(payload?.data);
    // Child subscriptions can expose only sparse item frames. The stored
    // assistant message supplies arguments; the exact tool receipt supplies
    // the accepted child key (never infer it from text or childSessions).
    const message = asOptionalRecord(payload?.message);
    if (
      evt.event === "session.message" &&
      message?.role === "assistant" &&
      Array.isArray(message.content)
    ) {
      for (const rawPart of message.content) {
        const part = asOptionalRecord(rawPart);
        if (
          part?.type === "toolCall" &&
          part.name === "sessions_spawn" &&
          typeof part.id === "string"
        ) {
          await this.handleEvent({
            ...evt,
            event: "agent",
            payload: {
              sessionKey: child.meta.id,
              stream: "tool",
              data: {
                phase: "start",
                name: "sessions_spawn",
                toolCallId: part.id,
                args: part.arguments,
              },
            },
          });
        }
      }
    }
    if (
      evt.event === "agent" &&
      payload?.stream === "item" &&
      data?.kind === "tool" &&
      data.name === "sessions_spawn" &&
      typeof data.toolCallId === "string"
    ) {
      const toolCallId = data.toolCallId;
      if (data.phase === "start") {
        await this.handleEvent({
          ...evt,
          payload: { sessionKey: child.meta.id, stream: "tool", data: { ...data, phase: "start" } },
        });
      } else if (data.phase === "end" && !child.spawnEnds.has(toolCallId)) {
        const history = await this.gateway
          .request<{ messages?: unknown[] }>(
            "sessions.get",
            { key: child.meta.id, limit: 50 },
            { timeoutMs: CLEANUP_TIMEOUT_MS },
          )
          .catch((err) => {
            this.log(`child spawn receipt unavailable: ${String(err)}`);
            return { messages: [] };
          });
        if (!this.active(child)) {
          return true;
        }
        const messages = (history.messages ?? []).map(asOptionalRecord);
        const receipt = messages.findLast(
          (row) =>
            row?.role === "toolResult" &&
            row.toolCallId === toolCallId &&
            row.toolName === "sessions_spawn",
        );
        if (receipt) {
          for (const row of messages) {
            if (row?.role === "assistant" && Array.isArray(row.content)) {
              const call = row.content
                .map(asOptionalRecord)
                .find((part) => part?.type === "toolCall" && part.id === toolCallId);
              if (call) {
                this.rememberSpawn(
                  child.meta.id,
                  toolCallId,
                  child.route,
                  asOptionalRecord(call.arguments),
                  child.meta.id,
                );
              }
            }
          }
          await this.handleEvent({
            ...evt,
            payload: {
              sessionKey: child.meta.id,
              stream: "tool",
              data: {
                name: "sessions_spawn",
                toolCallId,
                phase: "result",
                isError: receipt.isError,
                result: receipt,
              },
            },
          });
        }
      }
    }
    if (
      (evt.event === "agent" || evt.event === "session.tool") &&
      payload?.stream === "tool" &&
      data?.name === "sessions_spawn" &&
      typeof data.toolCallId === "string"
    ) {
      const toolCallId = data.toolCallId;
      if (data.phase === "start" && !child.spawnStarts.has(toolCallId)) {
        child.spawnStarts.add(toolCallId);
        this.rememberSpawn(
          child.meta.id,
          toolCallId,
          child.route,
          asOptionalRecord(data.args),
          child.meta.id,
        );
        await this.updates.emit({
          ...child.route,
          runId: child.route.idempotencyKey,
          record: true,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "sessions_spawn",
            kind: "other",
            status: "in_progress",
            rawInput: data.args,
            _meta: { openclaw: { toolName: "sessions_spawn", subagentId: child.meta.id } },
          },
        });
      } else if (data.phase === "result" && !child.spawnEnds.has(toolCallId)) {
        child.spawnEnds.add(toolCallId);
        const meta = this.acceptSpawn(child.meta.id, toolCallId, data.result);
        await this.updates.emit({
          ...child.route,
          runId: child.route.idempotencyKey,
          record: true,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: data.isError ? "failed" : "completed",
            rawOutput: data.result,
            _meta: {
              openclaw: {
                toolName: "sessions_spawn",
                subagentId: child.meta.id,
                ...(meta ? { subagent: meta } : {}),
              },
            },
          },
        });
        if (meta) {
          this.observe(meta.id);
        }
      }
    }
    // Text deltas/snapshots are not progress facts. Live and recorded changes share the throttle.
    let changed = false;
    if (evt.event === "agent" || evt.event === "session.tool") {
      if (typeof data?.model === "string") {
        const model = data.model.includes("/")
          ? data.model
          : typeof data.provider === "string"
            ? `${data.provider}/${data.model}`
            : null;
        if (model && model !== child.meta.model) {
          child.meta.model = model;
          changed = true;
        }
      }
      if (
        payload?.stream === "tool" &&
        (data?.phase === "start" || data?.phase === "result") &&
        typeof data.toolCallId === "string"
      ) {
        const signature = `${data.toolCallId}\0${data.phase}`;
        if (signature !== child.lastTool) {
          child.lastTool = signature;
          child.meta.activity = `${typeof data.name === "string" ? data.name : "Tool"} ${data.phase === "start" ? "started" : "finished"}`;
          changed = true;
        }
      } else if (
        payload?.stream === "lifecycle" &&
        typeof data?.phase === "string" &&
        data.phase !== child.lifecyclePhase
      ) {
        child.lifecyclePhase = data.phase;
        child.meta.activity = data.phase;
        changed = true;
      }
    }
    if (changed) {
      await this.progress(child);
    }
    return true;
  }
  async closeSession(sessionId: string): Promise<void> {
    for (const [key, spawn] of this.spawns) {
      if (spawn.route.sessionId === sessionId) {
        this.spawns.delete(key);
      }
    }
    await Promise.all(
      [...this.children.values()]
        .filter((child) => child.route.sessionId === sessionId)
        .map((child) => this.finish(child, "stopped", "Child stopped by the ACP client.", true)),
    );
  }
  async shutdown(): Promise<void> {
    this.draining = true;
    await Promise.all(
      [...new Set([...this.children.values()].map((child) => child.route.sessionId))].map((id) =>
        this.closeSession(id),
      ),
    );
    this.stopped = true;
    this.spawns.clear();
  }
}
