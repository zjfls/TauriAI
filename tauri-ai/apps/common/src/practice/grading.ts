import type {
  PracticeGrading,
  PracticeQuestion,
  PracticeQuestionProgress,
  PracticeQuestionType,
  PracticeQuizGrading,
} from "./types";

function now(): number {
  return Date.now();
}

function questionTypeLabel(type: PracticeQuestionType): string {
  if (type === "multiple_choice") return "选择题";
  if (type === "calculation") return "计算题";
  if (type === "proof") return "证明题";
  return "问答题";
}

function getQuestionMaxScore(question: PracticeQuestion): number {
  return Math.max(1, Math.round(question.points || 0));
}

export function buildPracticeChoiceGrading(question: PracticeQuestion, optionId?: string | null): PracticeGrading {
  if (question.type !== "multiple_choice") {
    throw new Error("buildPracticeChoiceGrading 仅支持选择题");
  }

  const maxScore = getQuestionMaxScore(question);
  const normalizedOptionId = String(optionId ?? "").trim();
  const isCorrect = normalizedOptionId !== "" && normalizedOptionId === question.correctOptionId;
  return {
    score: isCorrect ? maxScore : 0,
    maxScore,
    explanation: isCorrect ? "" : question.explanation?.trim() || `正确答案：${question.correctOptionId}`,
    gradedAt: now(),
  };
}

export function buildPracticeUnansweredGrading(
  question: PracticeQuestion,
  message = "未作答，当前题记 0 分。",
): PracticeGrading {
  return {
    score: 0,
    maxScore: getQuestionMaxScore(question),
    explanation: message,
    gradedAt: now(),
  };
}

function normalizeQuestionFeedback(question: PracticeQuestion, grading: PracticeGrading): string {
  const explanation = String(grading.explanation ?? "").trim();
  if (question.type === "multiple_choice" && grading.score >= grading.maxScore) {
    return "";
  }
  if (explanation) return explanation;
  if (question.type === "multiple_choice") {
    return `正确答案：${question.correctOptionId}`;
  }
  return "";
}

export function buildPracticeQuizGrading(
  questions: PracticeQuestion[],
  byQuestionId: Record<string, PracticeQuestionProgress>,
): PracticeQuizGrading {
  let score = 0;
  let maxScore = 0;
  let gradedQuestions = 0;
  const sections = ["## 总评"];

  questions.forEach((question, index) => {
    const progress = byQuestionId[question.id];
    const grading = progress?.grading;
    const questionMaxScore = getQuestionMaxScore(question);
    maxScore += questionMaxScore;
    if (grading) {
      score += grading.score;
      gradedQuestions += 1;
    }

    const detailLines = [`### 第${index + 1}题 ${questionTypeLabel(question.type)}`];
    if (!grading) {
      detailLines.push("未批改");
    } else {
      detailLines.push(`得分：${grading.score} / ${grading.maxScore}`);
      const feedback = normalizeQuestionFeedback(question, grading);
      if (feedback) {
        detailLines.push(feedback);
      }
    }
    sections.push("", detailLines.join("\n\n"));
  });

  sections.splice(1, 0, `- 总分：${score} / ${maxScore}`, `- 已批改：${gradedQuestions} / ${questions.length}`);

  return {
    score,
    maxScore,
    explanation: sections.join("\n").trim(),
    gradedAt: now(),
    totalQuestions: questions.length,
    gradedQuestions,
  };
}
