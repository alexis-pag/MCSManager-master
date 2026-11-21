import { describe, expect, it } from "vitest";
import { applyEdits, buildDiffPreview, normalizeInstancePath, parseEdits } from "../ai_file_edit";

describe("AI file edit helpers", () => {
  it("normalizes instance-relative paths and rejects traversal", () => {
    expect(normalizeInstancePath("server.properties")).toBe("/server.properties");
    expect(normalizeInstancePath("plugins\\Essentials\\config.yml")).toBe(
      "/plugins/Essentials/config.yml"
    );
    expect(normalizeInstancePath("../daemon/data/Config/global.json")).toBeNull();
    expect(normalizeInstancePath("/plugins/../../etc/passwd")).toBeNull();
    expect(normalizeInstancePath("bad\u0000name")).toBeNull();
    expect(normalizeInstancePath("")).toBeNull();
    expect(normalizeInstancePath(42)).toBeNull();
  });

  it("applies exact single-occurrence replacements only", () => {
    const original = "motd=Hello\nmax-players=20\npvp=true\n";
    expect(applyEdits(original, [{ find: "max-players=20", replace: "max-players=50" }])).toEqual({
      content: "motd=Hello\nmax-players=50\npvp=true\n"
    });
    expect(applyEdits(original, [{ find: "difficulty=easy", replace: "x" }])).toEqual({
      error: "Edit text not found"
    });
    expect(applyEdits("a=1\na=1\n", [{ find: "a=1", replace: "a=2" }])).toEqual({
      error: "Edit text is ambiguous"
    });
  });

  it("validates the edit list shape", () => {
    expect(parseEdits([{ find: "a", replace: "b" }])).toEqual([{ find: "a", replace: "b" }]);
    expect(parseEdits([])).toBeNull();
    expect(parseEdits([{ find: "", replace: "b" }])).toBeNull();
    expect(parseEdits([{ find: "a" }])).toBeNull();
    expect(parseEdits("a")).toBeNull();
  });

  it("builds a compact diff preview of the changed lines", () => {
    const preview = buildDiffPreview("a\nb\nc\n", "a\nB\nc\n");
    expect(preview).toBe("@@ line 2\n- b\n+ B");
    expect(buildDiffPreview("same", "same")).toBe("(no change)");
  });
});
