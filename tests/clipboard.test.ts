/**
 * clipboard.test.ts
 *
 * Tests for the clipboard utility:
 * - Platform-specific command selection (macOS, Linux, Windows)
 * - Command failure fallback behaviour (returns { ok: false } instead of throwing)
 * - Wayland → xclip Linux fallback
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process.execFileSync
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { copyToClipboard } from "../src/clipboard";

afterEach(() => {
  mockExecFileSync.mockReset();
  // Restore original platform
  Object.defineProperty(process, "platform", {
    value: process.platform,
    writable: true,
    configurable: true,
  });
});

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

describe("copyToClipboard (macOS)", () => {
  it("calls pbcopy with the text as stdin", () => {
    setPlatform("darwin");
    mockExecFileSync.mockReturnValue(undefined);

    const result = copyToClipboard("hello world");

    expect(result).toEqual({ ok: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "pbcopy",
      [],
      expect.objectContaining({ input: "hello world" }),
    );
  });

  it("returns ok: false when pbcopy fails", () => {
    setPlatform("darwin");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("pbcopy: command not found");
    });

    const result = copyToClipboard("test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("pbcopy");
    }
  });
});

// ---------------------------------------------------------------------------
// Linux (Wayland)
// ---------------------------------------------------------------------------

describe("copyToClipboard (Linux - Wayland)", () => {
  it("calls wl-copy and returns ok when it succeeds", () => {
    setPlatform("linux");
    mockExecFileSync.mockReturnValue(undefined);

    const result = copyToClipboard("wayland text");

    expect(result).toEqual({ ok: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "wl-copy",
      [],
      expect.objectContaining({ input: "wayland text" }),
    );
    // Should NOT fall through to xclip
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Linux (X11 fallback)
// ---------------------------------------------------------------------------

describe("copyToClipboard (Linux - xclip fallback)", () => {
  it("falls back to xclip when wl-copy fails", () => {
    setPlatform("linux");
    // First call (wl-copy) throws, second call (xclip) succeeds
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("wl-copy: not found");
      })
      .mockReturnValue(undefined);

    const result = copyToClipboard("xclip text");

    expect(result).toEqual({ ok: true });
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      "xclip",
      ["-selection", "clipboard"],
      expect.objectContaining({ input: "xclip text" }),
    );
  });

  it("returns ok: false when both wl-copy and xclip fail", () => {
    setPlatform("linux");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = copyToClipboard("text");

    expect(result.ok).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe("copyToClipboard (Windows)", () => {
  it("calls clip with the text as stdin", () => {
    setPlatform("win32");
    mockExecFileSync.mockReturnValue(undefined);

    const result = copyToClipboard("windows text");

    expect(result).toEqual({ ok: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "clip",
      [],
      expect.objectContaining({ input: "windows text" }),
    );
  });

  it("returns ok: false when clip fails", () => {
    setPlatform("win32");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("clip: error");
    });

    const result = copyToClipboard("text");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unsupported platform
// ---------------------------------------------------------------------------

describe("copyToClipboard (unsupported platform)", () => {
  it("returns ok: false with a helpful error message", () => {
    setPlatform("freebsd");

    const result = copyToClipboard("text");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("freebsd");
    }
    // Should not attempt any clipboard command
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
