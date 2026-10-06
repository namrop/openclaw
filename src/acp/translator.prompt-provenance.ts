import os from "node:os";
import { shortenHomePath } from "../utils.js";

export function buildSystemInputProvenance(originSessionId: string) {
  return {
    kind: "external_user" as const,
    originSessionId,
    sourceChannel: "acp",
    sourceTool: "openclaw_acp",
  };
}

export function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}) {
  return [
    "[Source Receipt]",
    "bridge=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `originSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}
