import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createNewSessionRequest,
  createLoadSessionRequest,
  createSetSessionConfigOptionRequest,
} from "./translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));
vi.mock("../agents/exec-defaults.js", () => ({ resolveExecDefaults: () => ({ mode: "auto" }) }));

function setup(existing = true) {
  const connection = createAcpConnection();
  const row = {
    key: "agent:other:t3:test",
    kind: "direct",
    modelProvider: "openai",
    model: "gpt-5.4",
    permissionMode: undefined as string | undefined,
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.list") {
      return {
        defaults: { modelProvider: "google", model: "gemini-2.5-flash" },
        sessions: existing ? [row] : [],
      };
    }
    if (method === "models.list") {
      return {
        models: [
          { provider: "openai", id: "gpt-5.4", name: "GPT 5.4" },
          { provider: "google", id: "gemini-2.5-flash", name: "Gemini Flash" },
        ],
      };
    }
    if (method === "config.get") {
      return { runtimeConfig: { tools: { exec: { mode: "auto" } } } };
    }
    if (method === "sessions.patch") {
      if (typeof params?.model === "string") {
        const [provider = "", ...model] = params.model.split("/");
        row.modelProvider = provider;
        row.model = model.join("/");
      }
      if (typeof params?.permissionMode === "string") {
        row.permissionMode = params.permissionMode;
      }
    }
    return { ok: true };
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore: createInMemorySessionStore() },
  );
  return { agent, connection, request };
}

describe("ACP model and access controls", () => {
  it("appends labeled gateway model refs and the effective default access without changing existing option order", async () => {
    const { agent, request } = setup();
    const result = await agent.loadSession(createLoadSessionRequest("agent:other:t3:test"));
    expect(result.configOptions?.map((option) => option.id)).toEqual([
      "thought_level",
      "fast_mode",
      "verbose_level",
      "trace_level",
      "reasoning_level",
      "response_usage",
      "elevated_level",
      "model",
      "permission_mode",
    ]);
    expect(result.configOptions).toContainEqual(
      expect.objectContaining({
        id: "model",
        type: "select",
        category: "model",
        name: "Model",
        currentValue: "openai/gpt-5.4",
        options: [
          { value: "openai/gpt-5.4", name: "GPT 5.4" },
          { value: "google/gemini-2.5-flash", name: "Gemini Flash" },
        ],
      }),
    );
    expect(result.configOptions).toContainEqual(
      expect.objectContaining({ id: "permission_mode", name: "Access", currentValue: "workspace" }),
    );
    expect(request).toHaveBeenCalledWith("models.list", { agentId: "other" });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "other" }),
    );
  });
  it("uses the scoped gateway agent default before a session row exists", async () => {
    const { agent } = setup(false);
    const result = await agent.newSession({
      ...createNewSessionRequest(),
      _meta: { sessionKey: "agent:other:t3:test" },
    });
    expect(result.configOptions).toContainEqual(
      expect.objectContaining({ id: "model", currentValue: "google/gemini-2.5-flash" }),
    );
  });
  it("patches and rereads model and permission controls, emitting refreshed snapshots", async () => {
    const { agent, request, connection } = setup();
    await agent.loadSession(createLoadSessionRequest("agent:other:t3:test"));
    for (const [id, value, field] of [
      ["model", "google/gemini-2.5-flash", "model"],
      ["permission_mode", "guarded", "permissionMode"],
      ["permission_mode", "workspace", "permissionMode"],
    ] as const) {
      const result = await agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("agent:other:t3:test", id, value),
      );
      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "agent:other:t3:test",
        [field]: value,
      });
      expect(result.configOptions).toContainEqual(
        expect.objectContaining({ id, currentValue: value }),
      );
      expect(connection["__sessionUpdateMock"]).toHaveBeenCalledWith({
        sessionId: "agent:other:t3:test",
        update: { sessionUpdate: "config_option_update", configOptions: result.configOptions },
      });
    }
  });
  it("rejects invalid permission modes and malformed model refs before patching", async () => {
    const { agent, request } = setup();
    await agent.loadSession(createLoadSessionRequest("agent:other:t3:test"));
    for (const [id, value] of [
      ["permission_mode", "yolo"],
      ["model", "no-provider"],
      ["model", "/missing-provider"],
    ] as const) {
      await expect(
        agent.setSessionConfigOption(
          createSetSessionConfigOptionRequest("agent:other:t3:test", id, value),
        ),
      ).rejects.toThrow();
    }
    expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
  });
});
