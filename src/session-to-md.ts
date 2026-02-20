import type { SessionInfo, FullMessage, MessagePart, ToolState } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters to include from a tool output before truncating. */
const TOOL_OUTPUT_MAX_CHARS = 500;

function truncateOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  return output.slice(0, TOOL_OUTPUT_MAX_CHARS) + "\n… [truncated]";
}

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------

function renderToolPart(part: MessagePart): string {
  const lines: string[] = [];
  const name = part.toolName ?? "unknown";

  lines.push(`**Tool: ${name}**`);
  lines.push("");

  if (part.args !== undefined) {
    lines.push("**Input:**");
    lines.push("```json");
    lines.push(JSON.stringify(part.args, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (part.state === "result" && part.result !== undefined) {
    const result = part.result;
    const resultStr = truncateOutput(
      typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2),
    );

    lines.push("**Output:**");
    // Only wrap in code block if not already markdown-formatted
    if (typeof result === "string" && !result.startsWith("```")) {
      lines.push("```");
      lines.push(resultStr);
      lines.push("```");
    } else {
      lines.push(resultStr);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderFilePart(part: MessagePart): string {
  if (part.filename) {
    return `**File:** \`${part.filename}\`\n`;
  }
  return "";
}

function renderOpenCodeToolPart(part: MessagePart): string {
  const lines: string[] = [];
  const name = part.tool ?? "unknown";
  const state = part.state as ToolState | undefined;

  lines.push(`**Tool: ${name}**`);
  lines.push("");

  if (state?.input !== undefined) {
    lines.push("**Input:**");
    lines.push("```json");
    lines.push(JSON.stringify(state.input, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (state?.output !== undefined) {
    const output = state.output;
    const outputStr = truncateOutput(
      typeof output === "string" ? output : JSON.stringify(output, null, 2),
    );
    lines.push("**Output:**");
    if (typeof output === "string" && !output.startsWith("```")) {
      lines.push("```");
      lines.push(outputStr);
      lines.push("```");
    } else {
      lines.push(outputStr);
    }
    lines.push("");
  } else if (state?.error) {
    lines.push(`**Error:** ${state.error}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderPart(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return (part.text ?? "").trim();

    case "tool-invocation":
      return renderToolPart(part);

    // OpenCode tool parts use type="tool" with a different shape
    case "tool":
      return renderOpenCodeToolPart(part);

    case "file":
      return renderFilePart(part);

    // Internal bookkeeping — skip silently
    case "step-start":
    case "step-finish":
    case "reasoning":
      return "";

    default:
      // Unknown part type — try to render text if present
      if (part.text) return part.text.trim();
      return "";
  }
}

// ---------------------------------------------------------------------------
// Message renderer
// ---------------------------------------------------------------------------

function formatDuration(msg: { info: { time?: { created?: number; completed?: number } } }): string {
  const { created, completed } = msg.info.time ?? {};
  if (created && completed) {
    const secs = ((completed - created) / 1000).toFixed(1);
    return `${secs}s`;
  }
  return "";
}

function renderMessageHeading(msg: FullMessage): string {
  const { role, agent, modelID } = msg.info;

  if (role === "user") {
    return "## User";
  }

  if (role === "tool") {
    return "## Tool Result";
  }

  // Assistant: include agent + model + duration where available
  const parts: string[] = [];
  if (agent) parts.push(agent);
  if (modelID) parts.push(modelID);
  const duration = formatDuration(msg);
  if (duration) parts.push(duration);

  const suffix = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  return `## Assistant${suffix}`;
}

function renderMessage(msg: FullMessage): string {
  const heading = renderMessageHeading(msg);
  const bodyParts = msg.parts
    .map(renderPart)
    .filter((s) => s.trim().length > 0);

  if (bodyParts.length === 0) return "";

  return [heading, "", bodyParts.join("\n\n"), ""].join("\n");
}

// ---------------------------------------------------------------------------
// Session renderer
// ---------------------------------------------------------------------------

/**
 * Converts an OpenCode session + its messages (as returned by the SDK) into
 * a single markdown string suitable for chunking and embedding.
 *
 * @param session   Session metadata from client.session.get()
 * @param messages  Messages array from client.session.messages()
 */
export function sessionToMarkdown(
  session: SessionInfo,
  messages: FullMessage[],
): string {
  const title = session.title ?? session.id;
  const directory = session.directory ?? "";

  const created = messages[0]?.info.time?.created;
  const updated = messages[messages.length - 1]?.info.time?.completed
    ?? messages[messages.length - 1]?.info.time?.created;

  const header = [
    `# ${title}`,
    "",
    `**Session ID:** ${session.id}`,
    directory ? `**Project:** ${directory}` : null,
    created
      ? `**Created:** ${new Date(created).toLocaleString()}`
      : null,
    updated
      ? `**Updated:** ${new Date(updated).toLocaleString()}`
      : null,
    "",
    "---",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const body = messages
    .map(renderMessage)
    .filter((s) => s.trim().length > 0)
    .join("\n---\n\n");

  return header + body;
}

/**
 * Converts a single message to markdown (used for incremental indexing of
 * individual new messages rather than the full session).
 */
export function messageToMarkdown(msg: FullMessage): string {
  return renderMessage(msg);
}
