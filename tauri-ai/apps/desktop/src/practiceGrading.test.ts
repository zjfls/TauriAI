import { describe, expect, it } from "vitest";
import { buildPracticeChoiceGrading, buildPracticeQuizGrading } from "../../common/src/practice/grading";

describe("practice grading helpers", () => {
  it("omits explanation for correct multiple choice answers", () => {
    expect(
      buildPracticeChoiceGrading(
        {
          id: "q-1",
          type: "multiple_choice",
          prompt: "1 + 1 = ?",
          points: 5,
          options: [
            { id: "A", text: "2" },
            { id: "B", text: "3" },
          ],
          correctOptionId: "A",
          explanation: "因为 1 + 1 = 2",
        },
        "A",
      ),
    ).toEqual({
      score: 5,
      maxScore: 5,
      explanation: "",
      gradedAt: expect.any(Number),
    });
  });

  it("builds quiz summary from per-question gradings", () => {
    const summary = buildPracticeQuizGrading(
      [
        {
          id: "q-1",
          type: "multiple_choice",
          prompt: "1 + 1 = ?",
          points: 5,
          options: [
            { id: "A", text: "2" },
            { id: "B", text: "3" },
          ],
          correctOptionId: "A",
          explanation: "",
        },
        {
          id: "q-2",
          type: "qa",
          prompt: "解释牛顿第二定律",
          points: 10,
          referenceAnswer: "F=ma",
          explanation: "",
        },
      ],
      {
        "q-1": {
          grading: {
            score: 5,
            maxScore: 5,
            explanation: "",
            gradedAt: 1,
          },
        },
        "q-2": {
          grading: {
            score: 8,
            maxScore: 10,
            explanation: "论证完整，但缺少单位说明。",
            gradedAt: 2,
          },
        },
      },
    );

    expect(summary.score).toBe(13);
    expect(summary.maxScore).toBe(15);
    expect(summary.gradedQuestions).toBe(2);
    expect(summary.totalQuestions).toBe(2);
    expect(summary.explanation).toContain("总分：13 / 15");
    expect(summary.explanation).toContain("### 第2题 问答题");
    expect(summary.explanation).toContain("论证完整，但缺少单位说明。");
  });
});
