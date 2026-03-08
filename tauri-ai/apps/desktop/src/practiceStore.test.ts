import { beforeEach, describe, expect, it } from "vitest";
import { usePracticeStore } from "../../common/src/practice/store";

function seedStore() {
  usePracticeStore.setState((state) => ({
    ...state,
    activeQuizId: "quiz_1",
    quizzes: [
      {
        id: "quiz_1",
        title: "旧练习",
        createdAt: 1,
        updatedAt: 1,
        questions: [
          {
            id: "old_calc_1",
            type: "calculation",
            prompt: "旧计算题 1",
            points: 10,
            referenceAnswer: "答案 1",
          },
          {
            id: "old_calc_2",
            type: "calculation",
            prompt: "旧计算题 2",
            points: 10,
            referenceAnswer: "答案 2",
          },
        ],
        progress: {
          byQuestionId: {
            old_calc_1: {
              answer: { kind: "text", text: "旧答案" },
              submittedAt: 1,
            },
          },
        },
      },
    ],
  }));
}

describe("practice store generation replacement", () => {
  beforeEach(() => {
    seedStore();
  });

  it("replaces previous generated questions instead of appending", () => {
    usePracticeStore.getState().replaceGeneratedQuestions("quiz_1", [
      {
        id: "new_mc_1",
        type: "multiple_choice",
        prompt: "新题目",
        points: 5,
        options: [
          { id: "A", text: "选项 A" },
          { id: "B", text: "选项 B" },
        ],
        correctOptionId: "A",
        explanation: "解析",
      },
    ]);

    const quiz = usePracticeStore.getState().quizzes[0];
    expect(quiz?.questions).toEqual([
      {
        id: "new_mc_1",
        type: "multiple_choice",
        prompt: "新题目",
        points: 5,
        options: [
          { id: "A", text: "选项 A" },
          { id: "B", text: "选项 B" },
        ],
        correctOptionId: "A",
        explanation: "解析",
      },
    ]);
    expect(quiz?.progress).toEqual({ byQuestionId: {}, quizGrading: undefined });
  });

  it("clears quiz summary once answers change", () => {
    usePracticeStore.getState().setQuizGrading("quiz_1", {
      score: 10,
      maxScore: 20,
      explanation: "旧总评",
      gradedAt: 2,
      totalQuestions: 2,
      gradedQuestions: 2,
    });

    usePracticeStore.getState().setAnswer("quiz_1", "old_calc_1", { kind: "text", text: "新的答案" });

    expect(usePracticeStore.getState().quizzes[0]?.progress?.quizGrading).toBeUndefined();
  });

});
