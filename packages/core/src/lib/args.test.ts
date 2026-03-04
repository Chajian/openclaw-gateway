import { describe, it, expect } from "vitest";
import { parseArgs, requireArg } from "./args.js";

describe("parseArgs", () => {
  it("parses --key value pairs", () => {
    const result = parseArgs(["--name", "alice", "--age", "30"]);
    expect(result).toEqual({ name: "alice", age: "30" });
  });

  it("parses boolean flags (no value after key)", () => {
    const result = parseArgs(["--verbose", "--dry-run"]);
    expect(result).toEqual({ verbose: true, "dry-run": true });
  });

  it("handles mixed flags and key-value pairs", () => {
    const result = parseArgs(["--site", "https://example.com", "--verbose", "--provider", "openai"]);
    expect(result).toEqual({
      site: "https://example.com",
      verbose: true,
      provider: "openai"
    });
  });

  it("ignores non-flag tokens", () => {
    const result = parseArgs(["positional", "--key", "val", "ignored"]);
    expect(result).toEqual({ key: "val" });
  });

  it("returns empty object for empty argv", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("treats --flag followed by --other as boolean for first", () => {
    const result = parseArgs(["--flag", "--other", "value"]);
    expect(result).toEqual({ flag: true, other: "value" });
  });
});

describe("requireArg", () => {
  it("returns value when present", () => {
    const args = parseArgs(["--site", "https://example.com"]);
    expect(requireArg(args, "site")).toBe("https://example.com");
  });

  it("throws with default message when missing", () => {
    expect(() => requireArg({}, "site")).toThrow("Missing --site");
  });

  it("throws with custom message when provided", () => {
    expect(() => requireArg({}, "site", "Need a site URL")).toThrow("Need a site URL");
  });
});
