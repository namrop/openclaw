/**
 * Hailing Frequency audio intake endpoint.
 *
 * Implements the transcript-only phase for `POST /v1/audio/intake`.
 */

import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { GatewayHttpAudioIntakeConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { logWarn } from "../logger.js";
import { transcribeAudioFile } from "../media-understanding/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";

const AUDIO_INTAKE_PATH = "/v1/audio/intake";
const DEFAULT_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const MIN_AUDIO_BYTES = 1;
const DEFAULT_ALLOWED_MIMES = [
  "audio/mp4",
  "audio/3gpp",
  "audio/aac",
  "audio/amr",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
];

export type AudioIntakeHttpOptions = {
  auth: ResolvedGatewayAuth;
  cfg: OpenClawConfig;
  config?: GatewayHttpAudioIntakeConfig;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

type MultipartForm = {
  fields: Map<string, string>;
  files: Map<string, MultipartPart>;
};

type BodyReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; status: number; message: string; type?: string };

export function isAudioIntakePath(pathname: string): boolean {
  return pathname === AUDIO_INTAKE_PATH;
}

function sendInvalidRequest(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, {
    ok: false,
    error: { type: "invalid_request_error", message },
  });
}

function sendServerError(res: ServerResponse, message: string) {
  sendJson(res, 500, {
    ok: false,
    error: { type: "server_error", message },
  });
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeMime(value: string | undefined): string | undefined {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return undefined;
  }
  return raw.split(";", 1)[0]?.trim() || undefined;
}

function resolveAllowedMimes(config: GatewayHttpAudioIntakeConfig | undefined): Set<string> {
  const raw = Array.isArray(config?.allowedMimes) ? config.allowedMimes : DEFAULT_ALLOWED_MIMES;
  const normalized = raw.map((value) => normalizeMime(value)).filter(Boolean) as string[];
  return new Set(normalized.length > 0 ? normalized : DEFAULT_ALLOWED_MIMES);
}

function parseContentLength(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  const declaredLength = parseContentLength(req);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    req.resume();
    return { ok: false, status: 413, message: "Payload too large" };
  }

  return await new Promise((resolve) => {
    let done = false;
    let ended = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      clearTimeout(timer);
    };

    const finish = (result: BodyReadResult) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!req.destroyed) {
        req.destroy();
      }
      finish({ ok: false, status: 408, message: "Request body timeout" });
    }, DEFAULT_BODY_TIMEOUT_MS);

    const onData = (chunk: Buffer | string) => {
      if (done) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        req.resume();
        finish({ ok: false, status: 413, message: "Payload too large" });
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      ended = true;
      finish({ ok: true, buffer: Buffer.concat(chunks) });
    };

    const onError = (error: Error) => {
      finish({ ok: false, status: 400, message: formatErrorMessage(error) });
    };

    const onClose = () => {
      if (done || ended) {
        return;
      }
      finish({ ok: false, status: 400, message: "Connection closed" });
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function parseMultipartBoundary(contentType: string | undefined): string | undefined {
  const raw = contentType ?? "";
  const [mediaType, ...params] = raw.split(";");
  if (normalizeLowercaseStringOrEmpty(mediaType) !== "multipart/form-data") {
    return undefined;
  }
  for (const param of params) {
    const [keyRaw, ...valueParts] = param.split("=");
    if (normalizeLowercaseStringOrEmpty(keyRaw) !== "boundary") {
      continue;
    }
    const value = valueParts.join("=").trim();
    if (!value) {
      return undefined;
    }
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return undefined;
}

function parsePartHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(line.slice(0, index));
    const value = line.slice(index + 1).trim();
    if (key) {
      headers.set(key, value);
    }
  }
  return headers;
}

function parseContentDisposition(value: string | undefined): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  if (!value) {
    return result;
  }
  for (const segment of value.split(";")) {
    const [keyRaw, ...valueParts] = segment.split("=");
    const key = normalizeLowercaseStringOrEmpty(keyRaw);
    if (key !== "name" && key !== "filename") {
      continue;
    }
    const joined = valueParts.join("=").trim();
    const unquoted = joined.startsWith('"') && joined.endsWith('"') ? joined.slice(1, -1) : joined;
    result[key] = unquoted;
  }
  return result;
}

function parseMultipartForm(buffer: Buffer, boundary: string): MultipartForm {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const nextDelimiterPrefix = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map<string, string>();
  const files = new Map<string, MultipartPart>();

  let position = buffer.indexOf(delimiter);
  if (position < 0) {
    throw new Error("multipart boundary not found");
  }

  while (position >= 0) {
    position += delimiter.length;
    const marker = buffer.subarray(position, position + 2).toString("utf8");
    if (marker === "--") {
      break;
    }
    if (marker !== "\r\n") {
      throw new Error("malformed multipart body");
    }
    position += 2;

    const headerEnd = buffer.indexOf(headerSeparator, position);
    if (headerEnd < 0) {
      throw new Error("multipart part headers missing terminator");
    }
    const headers = parsePartHeaders(buffer.subarray(position, headerEnd).toString("utf8"));
    const dataStart = headerEnd + headerSeparator.length;
    const dataEnd = buffer.indexOf(nextDelimiterPrefix, dataStart);
    if (dataEnd < 0) {
      throw new Error("multipart part missing closing boundary");
    }

    const disposition = parseContentDisposition(headers.get("content-disposition"));
    if (!disposition.name) {
      throw new Error("multipart part missing name");
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (disposition.filename !== undefined) {
      files.set(disposition.name, {
        name: disposition.name,
        filename: disposition.filename,
        contentType: normalizeMime(headers.get("content-type")),
        data,
      });
    } else {
      fields.set(disposition.name, data.toString("utf8"));
    }

    position = dataEnd + 2;
  }

  return { fields, files };
}

function extensionForAudio(params: { filename?: string; mime?: string }): string {
  const ext = path.extname(params.filename ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
    return ext;
  }
  switch (params.mime) {
    case "audio/mp4":
    case "audio/aac":
      return ".m4a";
    case "audio/3gpp":
      return ".3gp";
    case "audio/amr":
      return ".amr";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    default:
      return ".audio";
  }
}

function normalizeMode(raw: string | undefined): "transcribe" | "submit" | "both" | undefined {
  const mode = normalizeLowercaseStringOrEmpty(raw || "transcribe");
  if (mode === "transcribe" || mode === "submit" || mode === "both") {
    return mode;
  }
  return undefined;
}

async function writeTempAudioFile(params: {
  part: MultipartPart;
  config?: GatewayHttpAudioIntakeConfig;
}): Promise<{ dir: string; filePath: string }> {
  const tempRoot =
    normalizeOptionalString(params.config?.tempDir) ?? resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(tempRoot, "openclaw-audio-intake-"));
  const filePath = path.join(
    dir,
    `audio-${Date.now()}${extensionForAudio({ filename: params.part.filename, mime: params.part.contentType })}`,
  );
  await fs.writeFile(filePath, params.part.data, { mode: 0o600 });
  return { dir, filePath };
}

export async function handleAudioIntakeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AudioIntakeHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (!isAudioIntakePath(url.pathname)) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const maxBodyBytes = resolvePositiveInt(opts.config?.maxBodyBytes, DEFAULT_BODY_BYTES);
  const maxAudioBytes = resolvePositiveInt(opts.config?.maxAudioBytes, DEFAULT_AUDIO_BYTES);
  const boundary = parseMultipartBoundary(
    Array.isArray(req.headers["content-type"])
      ? req.headers["content-type"][0]
      : req.headers["content-type"],
  );
  if (!boundary) {
    sendInvalidRequest(res, 400, "Expected multipart/form-data with an audio file field");
    return true;
  }

  const body = await readBodyBuffer(req, maxBodyBytes);
  if (!body.ok) {
    sendInvalidRequest(res, body.status, body.message);
    return true;
  }

  let form: MultipartForm;
  try {
    form = parseMultipartForm(body.buffer, boundary);
  } catch (error) {
    sendInvalidRequest(res, 400, formatErrorMessage(error));
    return true;
  }

  const mode = normalizeMode(form.fields.get("mode"));
  if (!mode) {
    sendInvalidRequest(res, 400, "mode must be one of: transcribe, submit, both");
    return true;
  }
  if (mode !== "transcribe") {
    sendInvalidRequest(res, 400, "Only mode=transcribe is implemented for this endpoint phase");
    return true;
  }

  const audio = form.files.get("audio");
  if (!audio) {
    sendInvalidRequest(res, 400, "Missing multipart file field: audio");
    return true;
  }
  if (audio.data.length < MIN_AUDIO_BYTES) {
    sendInvalidRequest(res, 400, "Audio file is empty");
    return true;
  }
  if (audio.data.length > maxAudioBytes) {
    sendInvalidRequest(res, 413, "Audio file too large");
    return true;
  }

  const mime = normalizeMime(audio.contentType);
  const allowedMimes = resolveAllowedMimes(opts.config);
  if (!mime || !allowedMimes.has(mime)) {
    sendInvalidRequest(res, 400, "unsupported audio MIME type");
    return true;
  }

  let temp: { dir: string; filePath: string } | undefined;
  try {
    temp = await writeTempAudioFile({ part: audio, config: opts.config });
    const agentId = resolveDefaultAgentId(opts.cfg);
    const result = await transcribeAudioFile({
      filePath: temp.filePath,
      cfg: opts.cfg,
      agentDir: resolveAgentDir(opts.cfg, agentId),
      mime,
      language: normalizeOptionalString(form.fields.get("language")),
      prompt: normalizeOptionalString(form.fields.get("prompt")),
    });
    const transcript = normalizeOptionalString(result.text);
    if (!transcript) {
      sendInvalidRequest(res, 422, "No transcript returned for audio");
      return true;
    }
    if (opts.config?.debugRetainAudio !== true) {
      await fs.rm(temp.dir, { recursive: true, force: true }).catch(() => undefined);
      temp = undefined;
    }
    sendJson(res, 200, {
      ok: true,
      mode,
      transcript,
      delivery_status: "none",
    });
    return true;
  } catch (error) {
    logWarn(`audio intake failed: ${formatErrorMessage(error)}`);
    sendServerError(res, "audio transcription failed");
    return true;
  } finally {
    if (temp && opts.config?.debugRetainAudio !== true) {
      await fs.rm(temp.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
