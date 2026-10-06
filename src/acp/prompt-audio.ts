/** Converts ACP voice notes through the same file runtime used by channel audio. */
import { randomUUID } from "node:crypto";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { formatMediaUnderstandingBody } from "../../packages/media-understanding-common/src/format.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

export function createVoiceNoteTranscriptUpdate(transcript: string): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: randomUUID(),
    title: "Voice note transcript",
    kind: "other",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: `🎙️ "${transcript}"` } }],
    rawOutput: transcript,
    _meta: { openclaw: { toolName: "voice_note_transcript" } },
  };
}

export async function transcribePromptAudio(params: {
  prompt: ContentBlock[];
  sessionKey: string;
  cwd: string;
}): Promise<{ prompt: ContentBlock[]; transcripts: string[] }> {
  // Only voice prompts load the media runtime and config; text/image turns keep their fast path.
  const [{ loadConfig }, { saveMediaBuffer }, { transcribeAudioFile }, { resolveAgentDir }] =
    await Promise.all([
      import("../config/config.js"),
      import("../media/store.js"),
      import("../media-understanding/runtime.js"),
      import("../agents/agent-scope.js"),
    ]);
  const prompt: ContentBlock[] = [];
  const transcripts: string[] = [];
  for (const block of params.prompt) {
    if (block.type !== "audio") {
      prompt.push(block);
      continue;
    }
    let savedPath: string | undefined;
    let text: string;
    try {
      const data = block.data.startsWith("data:")
        ? block.data.slice(block.data.indexOf(",") + 1)
        : block.data;
      const saved = await saveMediaBuffer(Buffer.from(data, "base64"), block.mimeType);
      savedPath = saved.path;
      const cfg = loadConfig();
      const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
      const result = await transcribeAudioFile({
        filePath: saved.path,
        cfg,
        agentDir: agentId ? resolveAgentDir(cfg, agentId) : undefined,
        workspaceDir: params.cwd,
        mime: block.mimeType,
      });
      const transcript = result.text?.trim();
      if (transcript) {
        transcripts.push(transcript);
        text = formatMediaUnderstandingBody({
          outputs: [
            {
              kind: "audio.transcription",
              attachmentIndex: 0,
              text: transcript,
              provider: result.provider ?? "audio",
              model: result.model,
            },
          ],
        });
      } else {
        text = "[Voice note was empty or inaudible. Do not guess what was said.]";
      }
    } catch {
      text = savedPath
        ? `[Voice note could not be transcribed. Saved audio file: ${savedPath}. Do not guess what was said.]`
        : "[Voice note could not be saved or transcribed. Do not guess what was said.]";
    }
    prompt.push({ type: "text", text });
  }
  return { prompt, transcripts };
}
