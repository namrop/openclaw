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
};
type Spawn = { route: Route; args?: Record<string, unknown>; parentId: string | null };

export class AcpTranslatorSubagents {
  private readonly children = new Map<string, Child>();
  private readonly spawns = new Map<string, Spawn>();
  private stopped = false;
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
    this.spawns.set(`${sessionKey}\0${toolCallId}`, { route, args, parentId });
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
    if (!spawn || details?.status !== "accepted" || typeof details.childSessionKey !== "string") {
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
    });
    return meta;
  }
  observe(id: string): void {
    const child = this.children.get(id);
    if (child) {
      void this.monitor(child).catch((err) => this.log(`child observation failed: ${String(err)}`));
    }
  }
  private active(child: Child): boolean {
    return !this.stopped && this.children.get(child.meta.id) === child;
  }
  private async emit(child: Child, meta: AcpSubagentMeta): Promise<void> {
    if (!this.active(child)) {
      return;
    }
    await this.updates.emit({
      ...child.route,
      runId: child.route.idempotencyKey,
      record: true,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: child.toolCallId,
        _meta: { openclaw: { toolName: "sessions_spawn", subagent: { ...meta } } },
      },
    });
  }
  private async monitor(child: Child): Promise<void> {
    try {
      await this.gateway.request("sessions.messages.subscribe", { key: child.meta.id });
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
            .request<{ messages?: unknown[] }>("sessions.get", { key: child.meta.id, limit: 50 })
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
        await this.emit(child, {
          ...child.meta,
          event: "completed",
          status,
          summary: truncateUtf16Safe(summary, 20_000),
        });
        this.children.delete(child.meta.id);
        await this.unsubscribe(child);
        return;
      }
    } catch (err) {
      this.log(`child wait unavailable (not a child failure): ${String(err)}`);
    }
    if (this.active(child)) {
      child.timer = setTimeout(() => {
        void this.wait(child);
      }, 1_000);
      child.timer.unref();
    }
  }
  private async unsubscribe(child: Child): Promise<void> {
    await this.gateway
      .request("sessions.messages.unsubscribe", { key: child.meta.id })
      .catch(() => {});
  }
  async handleEvent(evt: EventFrame): Promise<boolean> {
    const payload = asOptionalRecord(evt.payload);
    const child =
      typeof payload?.sessionKey === "string" ? this.children.get(payload.sessionKey) : undefined;
    if (!child || !this.active(child)) {
      return false;
    }
    const data = asOptionalRecord(payload?.data);
    if (
      (evt.event === "agent" || evt.event === "session.tool") &&
      payload?.stream === "tool" &&
      data?.name === "sessions_spawn" &&
      typeof data.toolCallId === "string"
    ) {
      const toolCallId = data.toolCallId;
      if (data.phase === "start") {
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
            _meta: { openclaw: { toolName: "sessions_spawn" } },
          },
        });
      } else if (data.phase === "result") {
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
              openclaw: { toolName: "sessions_spawn", ...(meta ? { subagent: meta } : {}) },
            },
          },
        });
        if (meta) {
          this.observe(meta.id);
        }
      }
    }
    if (
      evt.event === "agent" ||
      evt.event === "chat" ||
      evt.event === "session.tool" ||
      evt.event === "session.message"
    ) {
      // Progress is observed activity, not an inferred completion. agent.wait owns the terminal fact.
      await this.emit(child, { ...child.meta, event: "progress" });
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
        .map(async (child) => {
          this.children.delete(child.meta.id);
          if (child.timer) {
            clearTimeout(child.timer);
          }
          await this.unsubscribe(child);
        }),
    );
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...new Set([...this.children.values()].map((child) => child.route.sessionId))].map((id) =>
        this.closeSession(id),
      ),
    );
    this.spawns.clear();
  }
}
