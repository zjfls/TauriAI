import { describe, expect, it } from "vitest";
import {
  createPracticeGenerationCountInputs,
  DEFAULT_PRACTICE_GENERATION_COUNTS,
  normalizePracticeGenerationCountValue,
  normalizePracticeGenerationCounts,
} from "../../common/src/practice/generation";

describe("practice generation count helpers", () => {
  it("uses fallback when the stored value is blank", () => {
    expect(normalizePracticeGenerationCountValue("", 10)).toBe(10);
    expect(normalizePracticeGenerationCountValue("   ", 3)).toBe(3);
    expect(normalizePracticeGenerationCountValue(undefined, 7)).toBe(7);
  });

  it("keeps defaults when counts are missing", () => {
    expect(
      normalizePracticeGenerationCounts({
        multiple_choice: "",
        calculation: undefined,
        proof: null,
      }),
    ).toEqual(DEFAULT_PRACTICE_GENERATION_COUNTS);
  });

  it("builds editable input strings from normalized values", () => {
    expect(
      createPracticeGenerationCountInputs({
        multiple_choice: "",
        calculation: 2,
        proof: "4",
      }),
    ).toEqual({
      multiple_choice: "10",
      calculation: "2",
      proof: "4",
      qa: "0",
    });
  });
});
