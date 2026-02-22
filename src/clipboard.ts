/**
 * clipboard.ts — cross-platform clipboard copy utility
 *
 * Platform priority:
 *   macOS   → pbcopy
 *   Linux   → wl-copy (Wayland), then xclip fallback
 *   Windows → clip
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
 * Never throws — callers print the content and give manual-copy instructions
 * if clipboard is unavailable.
 */

import { execFileSync } from "child_process";

export type ClipboardResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Copies `text` to the system clipboard.
 * Returns `{ ok: true }` on success, or `{ ok: false, error }` on failure.
 */
export function copyToClipboard(text: string): ClipboardResult {
  const platform = process.platform;

  if (platform === "darwin") {
    return runClipboard("pbcopy", [], text);
  }

  if (platform === "linux") {
    // Try Wayland first, then X11 fallback
    const wayland = runClipboard("wl-copy", [], text);
    if (wayland.ok) return wayland;
    return runClipboard("xclip", ["-selection", "clipboard"], text);
  }

  if (platform === "win32") {
    return runClipboard("clip", [], text);
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

function runClipboard(cmd: string, args: string[], text: string): ClipboardResult {
  try {
    execFileSync(cmd, args, { input: text, encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${cmd}: ${msg}` };
  }
}
