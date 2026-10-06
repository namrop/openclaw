import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveMediaBuffer: vi.fn(),
  transcribeAudioFile: vi.fn(),
}));
vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../agents/agent-scope.js", () => ({ resolveAgentDir: () => "/tmp/agent-main" }));
vi.mock("../media/store.js", () => ({ saveMediaBuffer: mocks.saveMediaBuffer }));
vi.mock("../media-understanding/runtime.js", () => ({
  transcribeAudioFile: mocks.transcribeAudioFile,
}));
vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

const key = "agent:main:t3:test-voice";
const audio: ContentBlock = {
  type: "audio",
  data: Buffer.from("voice bytes").toString("base64"),
  mimeType: "audio/webm",
};

async function setup() {
  const connection = createAcpConnection();
  const ledger = createTestAcpEventLedger();
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
    method === "chat.send" ? { status: "ok" } : { sessions: [], ok: true },
  );
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    { eventLedger: ledger, prefixCwd: false },
  );
  const { sessionId } = await agent.newSession({
    cwd: "/tmp",
    mcpServers: [],
    _meta: { sessionKey: key },
  });
  connection["__sessionUpdateMock"].mockClear();
  return { agent, connection, ledger, request, sessionId };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue({ tools: { media: { audio: { enabled: true } } } });
  mocks.saveMediaBuffer.mockResolvedValue({ path: "/tmp/inbound/voice.webm" });
  mocks.transcribeAudioFile.mockResolvedValue({ text: "Hello voice bridge." });
});

describe("ACP voice notes", () => {
  it("advertises audio without changing image or MCP capabilities", async () => {
    const { agent } = await setup();
    const result = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(result.agentCapabilities?.promptCapabilities).toMatchObject({
      audio: true,
      image: true,
    });
    expect(result.agentCapabilities?.mcpCapabilities).toEqual({ http: false, sse: false });
  });

  it("replaces each audio block in place and records the exact transcript echo before sending", async () => {
    const { agent, connection, ledger, request, sessionId } = await setup();
    mocks.transcribeAudioFile
      .mockResolvedValueOnce({ text: "Hello voice bridge." })
      .mockResolvedValueOnce({ text: "Second note." });
    const image: ContentBlock = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    await agent.prompt({
      sessionId,
      prompt: [
        { type: "text", text: "Before" },
        audio,
        image,
        { type: "text", text: "Between" },
        { ...audio, data: `data:audio/webm;base64,${audio.data}` },
        { type: "text", text: "After" },
      ],
    });
    const send = request.mock.calls.find(([method]) => method === "chat.send");
    expect(send?.[1]).toMatchObject({
      sessionKey: key,
      message:
        "Before\n[Audio]\nTranscript:\nHello voice bridge.\nBetween\n[Audio]\nTranscript:\nSecond note.\nAfter",
      attachments: [{ type: "image", mimeType: "image/png", content: image.data }],
    });
    expect(mocks.saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("voice bytes"),
      "audio/webm",
    );
    expect(mocks.saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("voice bytes"),
      "audio/webm",
    );
    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/inbound/voice.webm",
        cfg: mocks.loadConfig.mock.results[0].value,
        agentDir: "/tmp/agent-main",
        workspaceDir: "/tmp",
        mime: "audio/webm",
      }),
    );
    const echoes = connection["__sessionUpdateMock"].mock.calls
      .map(([notification]) => notification.update)
      .filter((update) => update._meta?.openclaw?.toolName === "voice_note_transcript");
    expect(echoes).toHaveLength(2);
    expect(echoes[0]).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: expect.any(String),
      title: "Voice note transcript",
      kind: "other",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: '🎙️ "Hello voice bridge."' } }],
      rawOutput: "Hello voice bridge.",
      _meta: { openclaw: { toolName: "voice_note_transcript" } },
    });
    expect(echoes[0].toolCallId).not.toBe(echoes[1].toolCallId);
    const echoIndex = connection["__sessionUpdateMock"].mock.calls.findIndex(
      ([notification]) => notification.update === echoes[0],
    );
    const sendIndex = request.mock.calls.findIndex(([method]) => method === "chat.send");
    expect(connection["__sessionUpdateMock"].mock.invocationCallOrder[echoIndex]).toBeLessThan(
      request.mock.invocationCallOrder[sendIndex],
    );
    const replay = await ledger.readReplay({ sessionId, sessionKey: key });
    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => event.update)).toEqual(expect.arrayContaining(echoes));
    const reconnected = createAcpConnection();
    const store = createInMemorySessionStore();
    const loaded = createAcpGatewayAgent(
      reconnected,
      createAcpGateway(request as GatewayClient["request"]),
      { eventLedger: ledger, sessionStore: store },
    );
    await loaded.loadSession({
      sessionId,
      cwd: "/tmp",
      mcpServers: [],
      _meta: { sessionKey: key },
    });
    expect(store.getSession(sessionId)?.sessionKey).toBe(key);
    for (const echo of echoes) {
      expect(reconnected["__sessionUpdateMock"]).toHaveBeenCalledWith({
        sessionId,
        update: echo,
      });
    }
  });

  it("tells the agent not to guess when the voice note has no words", async () => {
    const { agent, connection, request, sessionId } = await setup();
    mocks.transcribeAudioFile.mockResolvedValue({ text: "   " });
    await agent.prompt({ sessionId, prompt: [audio] });
    expect(request.mock.calls.find(([method]) => method === "chat.send")?.[1]).toMatchObject({
      message: expect.stringMatching(/empty or inaudible.*Do not guess/s),
    });
    expect(
      connection["__sessionUpdateMock"].mock.calls.some(
        ([notification]) =>
          notification.update._meta?.openclaw?.toolName === "voice_note_transcript",
      ),
    ).toBe(false);
  });

  it("preserves the saved path in a failure note instead of inventing a transcript", async () => {
    const { agent, connection, request, sessionId } = await setup();
    mocks.transcribeAudioFile.mockRejectedValue(new Error("transcription unavailable"));
    await agent.prompt({ sessionId, prompt: [audio] });
    expect(request.mock.calls.find(([method]) => method === "chat.send")?.[1]).toMatchObject({
      message: expect.stringMatching(/could not be transcribed.*\/tmp\/inbound\/voice.webm/s),
    });
    expect(
      connection["__sessionUpdateMock"].mock.calls.some(
        ([notification]) =>
          notification.update._meta?.openclaw?.toolName === "voice_note_transcript",
      ),
    ).toBe(false);
  });

  it("does not send a cancelled prompt after slow transcription completes", async () => {
    const { agent, request, sessionId } = await setup();
    let complete!: (value: { text: string }) => void;
    mocks.transcribeAudioFile.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const prompt = agent.prompt({ sessionId, prompt: [audio] });
    await vi.waitFor(() => expect(mocks.transcribeAudioFile).toHaveBeenCalled());
    const cancellation = agent.cancel({ sessionId });
    complete({ text: "Too late." });
    expect(await prompt).toEqual({ stopReason: "cancelled" });
    await cancellation;
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
});
