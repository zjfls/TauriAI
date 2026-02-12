import { describe, expect, it } from "vitest";
import { safeJsonParse } from "../../common/src/practice/json";

describe("practice json parsing", () => {
  it("parses fenced JSON", () => {
    const text = [
      "```json",
      "{\"title\":\"T\",\"questions\":[{\"type\":\"qa\",\"prompt\":\"p\",\"points\":1,\"referenceAnswer\":\"a\"}]}",
      "```",
    ].join("\n");

    const parsed = safeJsonParse(text) as any;
    expect(parsed?.title).toBe("T");
    expect(parsed?.questions?.[0]?.type).toBe("qa");
  });

  it("repairs common LaTeX backslash escapes in JSON strings", () => {
    const text =
      "{\"title\":\"T\",\"questions\":[{\"type\":\"calculation\",\"prompt\":\"计算 $a\\\\cdot b$ 与 $\\\\Delta$\",\"points\":10,\"referenceAnswer\":\"$a\\\\cdot b$\"}]}".replaceAll(
        "\\\\",
        "\\",
      );

    const parsed = safeJsonParse(text) as any;
    expect(parsed?.questions?.[0]?.prompt).toContain("\\cdot");
    expect(parsed?.questions?.[0]?.prompt).toContain("\\Delta");
  });

  it("avoids turning LaTeX commands into control characters (e.g. \\theta, \\frac)", () => {
    const text =
      "{\"title\":\"T\",\"questions\":[{\"type\":\"calculation\",\"prompt\":\"求 $\\\\theta$ 与 $\\\\frac{1}{2}$\",\"points\":10,\"referenceAnswer\":\"$\\\\theta$\"}]}".replaceAll(
        "\\\\",
        "\\",
      );

    const parsed = safeJsonParse(text) as any;
    const prompt = String(parsed?.questions?.[0]?.prompt ?? "");
    expect(prompt).toContain("\\theta");
    expect(prompt).toContain("\\frac");
    expect(prompt).not.toContain("\t");
    expect(prompt).not.toContain("\f");
  });
});
