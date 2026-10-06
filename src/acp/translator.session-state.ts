/** Gateway-backed ACP session snapshots, controls, metadata, and usage updates. */
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { toAcpSessionLineageMeta } from "@openclaw/acp-core/session-lineage-meta";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  ACP_MODEL_CONFIG_ID,
  ACP_PERMISSION_MODE_CONFIG_ID,
  ACP_ELEVATED_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_TIMEOUT_CONFIG_ID,
  ACP_TIMEOUT_SECONDS_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  buildSessionMetadata,
  buildSessionPresentation,
  buildSessionUsageSnapshot,
  type GatewaySessionPresentationRow,
  type SessionSnapshot,
} from "./translator.presentation.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export class AcpTranslatorSessionState {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly log: (msg: string) => void,
  ) {}

  async getSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const { row, models } = await this.getGatewayPresentation(sessionKey);
      return {
        ...buildSessionPresentation({ row, models, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (err) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  async getExistingSnapshot(sessionKey: string): Promise<SessionSnapshot> {
    const { row, models, exists } = await this.getGatewayPresentation(sessionKey);
    if (!exists) {
      throw new Error(`Session ${sessionKey} not found`);
    }
    return {
      ...buildSessionPresentation({ row, models }),
      metadata: buildSessionMetadata({ row, sessionKey }),
      usage: buildSessionUsageSnapshot(row),
    };
  }

  mapGatewaySession(session: GatewaySessionRow, fallbackCwd: string): SessionInfo {
    const cwd =
      normalizeOptionalString(session.spawnedCwd) ??
      normalizeOptionalString(session.spawnedWorkspaceDir) ??
      fallbackCwd;
    return {
      sessionId: session.key,
      cwd,
      title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      updatedAt: timestampMsToIsoString(session.updatedAt),
      _meta: toAcpSessionLineageMeta(session),
    };
  }

  async sendSnapshotUpdate(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean; record: boolean; runId?: string },
  ): Promise<void> {
    if (options.includeControls) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: sessionSnapshot.modes.currentModeId,
        },
      });
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: sessionSnapshot.configOptions,
        },
      });
    }
    if (sessionSnapshot.metadata) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "session_info_update",
          ...sessionSnapshot.metadata,
        },
      });
    }
    if (sessionSnapshot.usage) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        update: {
          sessionUpdate: "usage_update",
          used: sessionSnapshot.usage.used,
          size: sessionSnapshot.usage.size,
          _meta: {
            source: "gateway-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  resolveConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch?: Record<string, string | boolean | null>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    switch (configId) {
      case ACP_MODEL_CONFIG_ID:
        // Clearing the override also restores the agent's configured fallback chain.
        if (value === "default") {
          return { patch: { model: null }, overrides: {} };
        }
        if (!/^[^/\s]+\/\S+$/.test(value)) {
          throw new Error(`Unsupported model ref: ${value}`);
        }
        // Reread the authoritative row; a model patch can canonicalize aliases.
        return { patch: { model: value }, overrides: {} };
      case ACP_PERMISSION_MODE_CONFIG_ID:
        if (!["read-only", "guarded", "workspace", "full"].includes(value)) {
          throw new Error(`Unsupported permission mode: ${value}`);
        }
        return { patch: { permissionMode: value }, overrides: {} };
      case ACP_THOUGHT_LEVEL_CONFIG_ID:
        return {
          patch: { thinkingLevel: value },
          overrides: { thinkingLevel: value },
        };
      case ACP_FAST_MODE_CONFIG_ID: {
        const fastMode = normalizeFastMode(value);
        if (fastMode === undefined) {
          throw new Error(`Unsupported fast mode value: ${value}`);
        }
        return {
          patch: { fastMode },
          overrides: { fastMode },
        };
      }
      case ACP_VERBOSE_LEVEL_CONFIG_ID:
        return {
          patch: { verboseLevel: value },
          overrides: { verboseLevel: value },
        };
      case ACP_TRACE_LEVEL_CONFIG_ID:
        return {
          patch: { traceLevel: value },
          overrides: { traceLevel: value },
        };
      case ACP_REASONING_LEVEL_CONFIG_ID:
        return {
          patch: { reasoningLevel: value },
          overrides: { reasoningLevel: value },
        };
      case ACP_RESPONSE_USAGE_CONFIG_ID: {
        const next = value === "inherit" ? null : value;
        return {
          patch: { responseUsage: next },
          overrides: { responseUsage: next as GatewaySessionPresentationRow["responseUsage"] },
        };
      }
      case ACP_ELEVATED_LEVEL_CONFIG_ID:
        return {
          patch: { elevatedLevel: value },
          overrides: { elevatedLevel: value },
        };
      case ACP_TIMEOUT_CONFIG_ID:
      case ACP_TIMEOUT_SECONDS_CONFIG_ID:
        return {
          overrides: {},
        };
      default:
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
    }
  }

  private async getGatewayPresentation(sessionKey: string): Promise<{
    row: GatewaySessionPresentationRow;
    exists: boolean;
    models: Array<{ provider: string; id: string; name?: string }>;
  }> {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const scope = agentId ? { agentId } : {};
    const [result, catalog] = await Promise.all([
      this.gateway.request<SessionsListResult>("sessions.list", {
        limit: 200,
        search: sessionKey,
        includeDerivedTitles: true,
        ...scope,
      }),
      this.gateway
        .request<{ models?: Array<{ provider: string; id: string; name?: string }> }>(
          "models.list",
          scope,
        )
        .catch((err) => {
          this.log(`model catalog unavailable: ${String(err)}`);
          return { models: [] };
        }),
    ]);
    const session = result.sessions.find((entry) => entry.key === sessionKey);
    const row: GatewaySessionPresentationRow = {
      key: sessionKey,
      kind: "unknown",
      updatedAt: null,
      ...session,
      modelProvider: session?.modelProvider ?? result.defaults?.modelProvider ?? undefined,
      model: session?.model ?? result.defaults?.model ?? undefined,
    };
    if (!row.permissionMode) {
      try {
        // Read Gateway policy, not the bridge host's config/approval floors.
        const [snapshot, approvals, { resolveExecDefaults }, { SESSION_PERMISSION_BY_EXEC_MODE }] =
          await Promise.all([
            this.gateway.request<{ runtimeConfig?: OpenClawConfig; config?: OpenClawConfig }>(
              "config.get",
              {},
            ),
            this.gateway.request<{ file?: ExecApprovalsFile }>("exec.approvals.get", {}),
            import("../agents/exec-defaults.js"),
            import("../agents/session-permission-exec-mode.js"),
          ]);
        if (snapshot.runtimeConfig ?? snapshot.config) {
          const defaults = resolveExecDefaults({
            cfg: snapshot.runtimeConfig ?? snapshot.config,
            execApprovals: approvals.file ?? { version: 1 },
            sessionKey,
            agentId,
          });
          row.permissionMode = SESSION_PERMISSION_BY_EXEC_MODE[defaults.mode];
        }
      } catch (err) {
        // Never advertise fabricated access when the authoritative policy is unavailable.
        this.log(`access default unavailable: ${String(err)}`);
      }
    }
    return { row, exists: Boolean(session), models: catalog.models ?? [] };
  }
}
