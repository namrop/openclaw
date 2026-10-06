import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import { isRecentSessionMaintenanceEntry } from "../config/sessions/store-maintenance.js";
import type { GatewayClient } from "../gateway/client.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

describe("lasting T3 session keys", () => {
  it("is an ordinary session rather than a disposable synthetic ACP session", () => {
    const activity = {
      entry: { sessionId: "fixture", updatedAt: 1000 },
      preserveRecentMs: 1000,
      nowMs: 1500,
    };
    expect(isRecentSessionMaintenanceEntry({ ...activity, key: "agent:main:t3:thread-id" })).toBe(
      true,
    );
    expect(
      isRecentSessionMaintenanceEntry({ ...activity, key: "agent:main:acp-bridge:thread-id" }),
    ).toBe(false);
    expect(isRecentSessionMaintenanceEntry({ ...activity, key: "agent:main:acp:thread-id" })).toBe(
      false,
    );
  });

  it("binds new, load and resume with explicit metadata to the same Gateway session", async () => {
    const key = "agent:main:t3:thread-id";
    const ledger = createTestAcpEventLedger();
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === "sessions.list"
        ? { sessions: [{ key, sessionId: "gateway-id", updatedAt: 1000 }] }
        : { status: "ok" },
    );
    const gateway = createAcpGateway(request as GatewayClient["request"]);
    const firstStore = createInMemorySessionStore();
    const first = createAcpGatewayAgent(createAcpConnection(), gateway, {
      eventLedger: ledger,
      sessionStore: firstStore,
      prefixCwd: false,
    });
    const meta = { sessionKey: key };
    const { sessionId } = await first.newSession({ cwd: "/tmp", mcpServers: [], _meta: meta });
    expect(firstStore.getSession(sessionId)?.sessionKey).toBe(key);
    await first.prompt({ sessionId, prompt: [{ type: "text", text: "First" }] });
    const secondStore = createInMemorySessionStore();
    const second = createAcpGatewayAgent(createAcpConnection(), gateway, {
      eventLedger: ledger,
      sessionStore: secondStore,
      prefixCwd: false,
    });
    await second.loadSession({ sessionId, cwd: "/tmp", mcpServers: [], _meta: meta });
    expect(secondStore.getSession(sessionId)?.sessionKey).toBe(key);
    await second.prompt({ sessionId, prompt: [{ type: "text", text: "Loaded" }] });
    const thirdStore = createInMemorySessionStore();
    const third = createAcpGatewayAgent(createAcpConnection(), gateway, {
      eventLedger: ledger,
      sessionStore: thirdStore,
      prefixCwd: false,
    });
    await third.resumeSession({ sessionId, cwd: "/tmp", mcpServers: [], _meta: meta });
    expect(thirdStore.getSession(sessionId)?.sessionKey).toBe(key);
    await third.prompt({ sessionId, prompt: [{ type: "text", text: "Resumed" }] });
    const sends = request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(3);
    for (const call of sends) {
      expect(call[1]).toMatchObject({ sessionKey: key });
    }
  });
});
