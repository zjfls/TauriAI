import { describe, expect, it } from "vitest";
import { buildPracticeQuestionChatPrompt } from "../../common/src/practice/chatPrompt";

describe("buildPracticeQuestionChatPrompt", () => {
  it("builds a text prompt for written questions", () => {
    expect(
      buildPracticeQuestionChatPrompt({
        id: "q-1",
        type: "qa",
        prompt: "解释牛顿第二定律",
        points: 10,
      }),
    ).toBe("解答题目\n解释牛顿第二定律");
  });

  it("includes options for multiple choice questions", () => {
    expect(
      buildPracticeQuestionChatPrompt({
        id: "q-2",
        type: "multiple_choice",
        prompt: "下列哪项正确？",
        options: [
          { id: "A", text: "选项一" },
          { id: "B", text: "选项二" },
        ],
        correctOptionId: "A",
        explanation: "",
        points: 5,
      }),
    ).toBe("解答题目\n下列哪项正确？\n\nA. 选项一\nB. 选项二");
  });
});
