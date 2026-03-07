import type { PracticeQuestionType } from "./types";

export type PracticeGenerationCounts = Record<PracticeQuestionType, number>;

export const PRACTICE_GENERATION_FIELDS: Array<{ type: PracticeQuestionType; label: string }> = [
  { type: "multiple_choice", label: "选择题" },
  { type: "calculation", label: "计算题" },
  { type: "proof", label: "证明题" },
  { type: "qa", label: "问答题" },
];

export const DEFAULT_PRACTICE_GENERATION_COUNTS: PracticeGenerationCounts = {
  multiple_choice: 10,
  calculation: 0,
  proof: 0,
  qa: 0,
};

export function normalizePracticeGenerationCountValue(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(20, Math.round(safe)));
}

export function normalizePracticeGenerationCounts(
  counts: Partial<Record<PracticeQuestionType, unknown>>,
  fallback: Partial<Record<PracticeQuestionType, number>> = DEFAULT_PRACTICE_GENERATION_COUNTS,
): PracticeGenerationCounts {
  return {
    multiple_choice: normalizePracticeGenerationCountValue(
      counts.multiple_choice,
      fallback.multiple_choice ?? DEFAULT_PRACTICE_GENERATION_COUNTS.multiple_choice,
    ),
    calculation: normalizePracticeGenerationCountValue(
      counts.calculation,
      fallback.calculation ?? DEFAULT_PRACTICE_GENERATION_COUNTS.calculation,
    ),
    proof: normalizePracticeGenerationCountValue(
      counts.proof,
      fallback.proof ?? DEFAULT_PRACTICE_GENERATION_COUNTS.proof,
    ),
    qa: normalizePracticeGenerationCountValue(
      counts.qa,
      fallback.qa ?? DEFAULT_PRACTICE_GENERATION_COUNTS.qa,
    ),
  };
}

export function totalPracticeGenerationCounts(counts: Partial<Record<PracticeQuestionType, unknown>>): number {
  const normalized = normalizePracticeGenerationCounts(counts);
  return normalized.multiple_choice + normalized.calculation + normalized.proof + normalized.qa;
}
