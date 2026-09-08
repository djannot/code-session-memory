/**
 * Analytics backfill — re-extracts the structured analytics rows (messages +
 * tool_calls) for already-indexed sessions WITHOUT re-embedding anything.
 *
 * Needed once after upgrading to a version that added per-model columns
 * (model, token usage) to the `messages` table: sessions that are continued
 * are backfilled automatically by the indexer's upsert, but sessions that are
 * never touched again keep NULL model/token columns until this runs.
 *
 * Supported sources: claude-code (from the JSONL transcript on disk) and
 * opencode (from OpenCode's internal SQLite DB). Other sources are skipped.
 */

import type { DatabaseProvider } from "./providers/types";
import type { FullMessage, SessionSource } from "./types";
import { extractAnalyticsData } from "./indexer";
import { parseTranscript } from "./transcript-to-messages";
import { getMessagesFromOpenCodeDb } from "./opencode-db-to-messages";
import { resolveTranscriptPath } from "./transcript-discovery";

export const BACKFILL_SOURCES: ReadonlySet<SessionSource> = new Set<SessionSource>(["claude-code", "opencode"]);

export interface BackfillSessionResult {
  sessionId: string;
  source: SessionSource;
  status: "updated" | "skipped" | "failed";
  /** Assistant messages that now carry a model (updated sessions only). */
  messagesWithModel?: number;
  reason?: string;
}

export interface BackfillOptions {
  /** Restrict to these sources (default: every supported source). */
  sources?: SessionSource[];
  /** Parse and report but do not write. */
  dryRun?: boolean;
  onProgress?: (done: number, total: number, last: BackfillSessionResult) => void;
}

export interface BackfillReport {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  results: BackfillSessionResult[];
}

/** Loads the full message list of a session from its original source, or null when unavailable. */
function loadMessages(
  meta: { session_id: string; source: SessionSource; transcript_path?: string | null },
): { messages: FullMessage[] } | { reason: string } {
  switch (meta.source) {
    case "claude-code": {
      const transcriptPath = resolveTranscriptPath(meta as Parameters<typeof resolveTranscriptPath>[0]);
      if (!transcriptPath) return { reason: "Transcript not found on disk" };
      return { messages: parseTranscript(transcriptPath) };
    }
    case "opencode": {
      const messages = getMessagesFromOpenCodeDb(meta.session_id);
      if (!messages) return { reason: "Session not found in OpenCode DB" };
      return { messages };
    }
    default:
      return { reason: `Source "${meta.source}" is not supported` };
  }
}

export async function backfillAnalytics(
  provider: DatabaseProvider,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const wanted = new Set<SessionSource>(
    (options.sources ?? [...BACKFILL_SOURCES]).filter((s) => BACKFILL_SOURCES.has(s)),
  );

  const sessions = (await provider.listSessions()).filter((s) => wanted.has(s.source));
  const report: BackfillReport = { total: sessions.length, updated: 0, skipped: 0, failed: 0, results: [] };

  let done = 0;
  for (const row of sessions) {
    let result: BackfillSessionResult;
    try {
      // listSessions() does not return transcript_path — fetch the full meta row.
      const meta = (await provider.getSessionMeta(row.session_id)) ?? row;
      const loaded = loadMessages(meta);
      if ("reason" in loaded) {
        result = { sessionId: row.session_id, source: row.source, status: "skipped", reason: loaded.reason };
      } else if (loaded.messages.length === 0) {
        result = { sessionId: row.session_id, source: row.source, status: "skipped", reason: "No messages" };
      } else {
        const { messageRows, toolCallRows } = extractAnalyticsData(loaded.messages, row.session_id, Date.now());
        if (!options.dryRun) {
          await provider.insertMessages(messageRows);
          await provider.deleteToolCallsBySession(row.session_id);
          await provider.insertToolCalls(toolCallRows);
        }
        result = {
          sessionId: row.session_id,
          source: row.source,
          status: "updated",
          messagesWithModel: messageRows.filter((m) => m.role === "assistant" && m.model !== null).length,
        };
      }
    } catch (err) {
      result = {
        sessionId: row.session_id,
        source: row.source,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    report[result.status === "updated" ? "updated" : result.status === "skipped" ? "skipped" : "failed"]++;
    report.results.push(result);
    done++;
    options.onProgress?.(done, sessions.length, result);
  }

  if (!options.dryRun) await provider.checkpoint();
  return report;
}
