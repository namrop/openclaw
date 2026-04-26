---
name: discord
description: "Discord ops via the message tool (channel=discord)."
metadata: { "openclaw": { "emoji": "🎮", "requires": { "config": ["channels.discord.token"] } } }
allowed-tools: ["message"]
---

# Discord (Via `message`)

Use the `message` tool. No provider-specific `discord` tool exposed to the agent.

## Musts

- Always: `channel: "discord"`.
- Respect gating: `channels.discord.actions.*` (some default off: `roles`, `moderation`, `presence`, `channels`).
- Prefer explicit ids: `guildId`, `channelId`, `messageId`, `userId`.
- Multi-account: optional `accountId`.

## Guidelines

- Avoid Markdown tables in outbound Discord messages.
- Mention users as `<@USER_ID>`.
- Prefer Discord components v2 (`components`) for rich UI; use legacy `embeds` only when you must.

## Targets

- Send-like actions: use `target: "channel:<id>"` for channels/threads or `target: "user:<id>"` for DMs.
- For the current Discord thread/channel, send to `target: "channel:<thread-or-channel-id>"`; only use `target: "user:<id>"` when a DM is explicitly requested.
- Message-specific actions: use `channelId: "<id>"` (or `target: "channel:<id>"` where supported) + `messageId: "<id>"`.
- Older notes/examples may mention `to`; prefer `target` because it matches the live message tool schema.

## Common Actions (Examples)

Send message:

```json
{
  "action": "send",
  "channel": "discord",
  "target": "channel:123",
  "message": "hello",
  "silent": true
}
```

Send with media:

```json
{
  "action": "send",
  "channel": "discord",
  "target": "channel:123",
  "message": "see attachment",
  "media": "file:///tmp/example.png"
}
```

- For local files, use the message tool `media: "file:///absolute/path"` field. Do **not** rely on inline assistant `MEDIA:/absolute/path` lines for Discord delivery; absolute local `MEDIA:` lines can be stripped/blocked and surface as `⚠️ Media failed`.
- If the attachment should land in the current thread, use `target: "channel:<thread-id>"`, not `target: "user:<id>"`.

- Optional `silent: true` to suppress Discord notifications.

Send with components v2 (recommended for rich UI):

```json
{
  "action": "send",
  "channel": "discord",
  "target": "channel:123",
  "message": "Status update",
  "components": "[Carbon v2 components]"
}
```

- `components` expects Carbon component instances (Container, TextDisplay, etc.) from JS/TS integrations.
- Do not combine `components` with `embeds` (Discord rejects v2 + embeds).

Legacy embeds (not recommended):

```json
{
  "action": "send",
  "channel": "discord",
  "target": "channel:123",
  "message": "Status update",
  "embeds": [{ "title": "Legacy", "description": "Embeds are legacy." }]
}
```

- `embeds` are ignored when components v2 are present.

React:

```json
{
  "action": "react",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "emoji": "✅"
}
```

Read:

```json
{
  "action": "read",
  "channel": "discord",
  "target": "channel:123",
  "limit": 20
}
```

Edit / delete:

```json
{
  "action": "edit",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "message": "fixed typo"
}
```

```json
{
  "action": "delete",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

Poll:

```json
{
  "action": "poll",
  "channel": "discord",
  "target": "channel:123",
  "pollQuestion": "Lunch?",
  "pollOption": ["Pizza", "Sushi", "Salad"],
  "pollMulti": false,
  "pollDurationHours": 24
}
```

Pins:

```json
{
  "action": "pin",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456"
}
```

Threads:

```json
{
  "action": "thread-create",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "threadName": "bug triage"
}
```

Search:

```json
{
  "action": "search",
  "channel": "discord",
  "guildId": "999",
  "query": "release notes",
  "channelIds": ["123", "456"],
  "limit": 10
}
```

Presence (often gated):

```json
{
  "action": "set-presence",
  "channel": "discord",
  "activityType": "playing",
  "activityName": "with fire",
  "status": "online"
}
```

## Writing Style (Discord)

- Short, conversational, low ceremony.
- No markdown tables.
- Mention users as `<@USER_ID>`.
