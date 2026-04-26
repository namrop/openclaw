---
summary: "Accept private multipart audio uploads at /v1/audio/intake and transcribe them with Gateway media understanding"
read_when:
  - Integrating a trusted phone, Tasker task, or local voice capture client with OpenClaw
  - You want local audio transcription through the Gateway without using a chat attachment surface
  - You are configuring the Hailing Frequency Luna audio-intake path
title: "Audio Intake API"
---

OpenClaw’s Gateway can serve a private audio-intake endpoint:

- `POST /v1/audio/intake`
- Same port as the Gateway: `http://<gateway-host>:<port>/v1/audio/intake`

This endpoint is **disabled by default**. Enable it only on private ingress, such as loopback,
Tailscale Serve, or a trusted reverse proxy protected by Gateway auth.

The first implementation phase is transcript-only: upload audio as `multipart/form-data`, run the
existing `tools.media.audio` transcription pipeline, return JSON containing the transcript, and then
delete the temporary raw audio file by default.

## Enable

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "audioIntake": {
          "enabled": true
        }
      }
    }
  }
}
```

Optional limits:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "audioIntake": {
          "enabled": true,
          "maxBodyBytes": 26214400,
          "maxAudioBytes": 20971520,
          "allowedMimes": ["audio/mp4", "audio/aac", "audio/wav", "audio/webm"],
          "debugRetainAudio": false
        }
      }
    }
  }
}
```

## Authentication

Use the normal Gateway HTTP auth path:

- shared-secret auth: `Authorization: Bearer <gateway-token-or-password>`
- trusted-proxy auth: identity-aware proxy headers from a configured trusted proxy
- private loopback/open auth: no auth header when `gateway.auth.mode="none"`

Do not expose this endpoint publicly without Gateway auth. A valid caller can upload audio and spend
local transcription resources.

## Request

Use `multipart/form-data`.

Required file field:

- `audio`: uploaded audio file

Optional text fields:

- `mode`: currently only `transcribe` is implemented
- `language`: transcription language hint
- `prompt`: transcription prompt/context hint
- `source`, `intent`, `created_at`: accepted for client-side convention; currently not routed into a session

Example:

```bash
curl -sS \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -F mode=transcribe \
  -F source=luna-tasker \
  -F intent=quick_capture \
  -F audio=@capture.m4a\;type=audio/mp4 \
  http://127.0.0.1:18789/v1/audio/intake
```

## Response

Success:

```json
{
  "ok": true,
  "mode": "transcribe",
  "transcript": "hello from luna",
  "delivery_status": "none"
}
```

Failures use Gateway JSON error shape:

```json
{
  "ok": false,
  "error": {
    "type": "invalid_request_error",
    "message": "unsupported audio MIME type"
  }
}
```

## Retention

Raw audio is written to a `0600` temporary file under OpenClaw’s preferred temp directory and deleted
after transcription by default. Set `debugRetainAudio=true` only for short debugging windows.

## Current limitations

- `mode=submit` and `mode=both` are intentionally not implemented yet.
- The endpoint does not wait for or deliver an assistant response.
- Return-path notifications are outside this first phase.

For the Luna/Tasker design lane, see the Hailing Frequency notes in the Atrium.
