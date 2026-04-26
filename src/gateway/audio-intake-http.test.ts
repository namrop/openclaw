import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

const { transcribeAudioFileMock } = vi.hoisted(() => ({
  transcribeAudioFileMock: vi.fn(),
}));

vi.mock("../media-understanding/runtime.js", () => ({
  transcribeAudioFile: transcribeAudioFileMock,
}));

installGatewayTestHooks({ scope: "suite" });

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  resetConfigRuntimeState();
}

async function enableAudioIntake(overrides: Record<string, unknown> = {}) {
  await writeGatewayConfig({
    gateway: {
      http: {
        endpoints: {
          audioIntake: {
            enabled: true,
            ...overrides,
          },
        },
      },
    },
  });
}

async function withServer<T>(
  fn: (ctx: { port: number }) => Promise<T>,
  opts?: { auth?: { mode: "none" } | { mode: "token"; token: string } },
): Promise<T> {
  const started = await startGatewayServerWithRetries({
    port: await getFreePort(),
    opts: {
      host: "127.0.0.1",
      auth: opts?.auth ?? { mode: "none" },
      controlUiEnabled: false,
    },
  });
  try {
    return await fn({ port: started.port });
  } finally {
    await started.server.close();
  }
}

function makeAudioForm(params?: {
  bytes?: Uint8Array | Buffer | string;
  mime?: string;
  filename?: string;
  fields?: Record<string, string>;
}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params?.fields ?? {})) {
    form.set(key, value);
  }
  const bytes = params?.bytes ?? Buffer.from("fake audio bytes");
  const blobPart: BlobPart = typeof bytes === "string" ? bytes : new Uint8Array(Array.from(bytes));
  form.set(
    "audio",
    new Blob([blobPart], { type: params?.mime ?? "audio/mp4" }),
    params?.filename ?? "capture.m4a",
  );
  return form;
}

async function postAudio(
  port: number,
  params?: {
    form?: FormData;
    headers?: Record<string, string>;
  },
) {
  return await fetch(`http://127.0.0.1:${port}/v1/audio/intake`, {
    method: "POST",
    headers: params?.headers,
    body: params?.form ?? makeAudioForm(),
  });
}

describe("audio intake HTTP endpoint", () => {
  it("returns 404 when the endpoint is disabled", async () => {
    await writeGatewayConfig({});
    await withServer(async ({ port }) => {
      const res = await postAudio(port);
      expect(res.status).toBe(404);
    });
  });

  it("rejects non-POST requests when enabled", async () => {
    await enableAudioIntake();
    await withServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/audio/intake`);
      expect(res.status).toBe(405);
    });
  });

  it("requires gateway auth when configured", async () => {
    await enableAudioIntake();
    await withServer(
      async ({ port }) => {
        const res = await postAudio(port);
        expect(res.status).toBe(401);
      },
      { auth: { mode: "token", token: "secret" } },
    );
  });

  it("rejects multipart bodies without an audio file field", async () => {
    await enableAudioIntake();
    await withServer(async ({ port }) => {
      const form = new FormData();
      form.set("mode", "transcribe");
      const res = await postAudio(port, { form });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message).toContain("Missing multipart file field: audio");
    });
  });

  it("rejects unsupported audio MIME types", async () => {
    await enableAudioIntake();
    await withServer(async ({ port }) => {
      const res = await postAudio(port, { form: makeAudioForm({ mime: "text/plain" }) });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message).toContain("unsupported audio MIME type");
    });
  });

  it("rejects oversized multipart requests", async () => {
    await enableAudioIntake({ maxBodyBytes: 64 });
    await withServer(async ({ port }) => {
      const res = await postAudio(port, {
        form: makeAudioForm({ bytes: Buffer.alloc(1024), mime: "audio/mp4" }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("returns transcript JSON and deletes temporary audio after success", async () => {
    await enableAudioIntake();
    let capturedFilePath: string | undefined;
    transcribeAudioFileMock.mockImplementationOnce(async (params: { filePath: string }) => {
      capturedFilePath = params.filePath;
      await expect(fs.readFile(params.filePath)).resolves.toEqual(Buffer.from("hello audio"));
      return { text: "hello from luna" };
    });

    await withServer(async ({ port }) => {
      const res = await postAudio(port, {
        form: makeAudioForm({ bytes: "hello audio", mime: "audio/mp4" }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        mode: "transcribe",
        transcript: "hello from luna",
        delivery_status: "none",
      });
    });

    expect(capturedFilePath).toBeDefined();
    await expect(fs.access(capturedFilePath!)).rejects.toBeTruthy();
  });

  it("returns 422 when transcription produces no text", async () => {
    await enableAudioIntake();
    transcribeAudioFileMock.mockResolvedValueOnce({ text: undefined });
    await withServer(async ({ port }) => {
      const res = await postAudio(port);
      expect(res.status).toBe(422);
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message).toContain("No transcript returned");
    });
  });

  it("rejects submit and both modes in the transcript-only phase", async () => {
    await enableAudioIntake();
    await withServer(async ({ port }) => {
      const res = await postAudio(port, {
        form: makeAudioForm({ fields: { mode: "both" } }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message).toContain("Only mode=transcribe");
    });
  });
});
