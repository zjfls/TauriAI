export type PracticeQuestionType = "multiple_choice" | "calculation" | "proof" | "qa";

export type PracticeQuizId = string;
export type PracticeQuestionId = string;

export type InkStrokeId = string;

export type InkToolKind = "pen";

export type InkColor = string; // CSS color

export interface InkPoint {
  x: number;
  y: number;
  t: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
}

export interface InkStroke {
  id: InkStrokeId;
  tool: InkToolKind;
  color: InkColor;
  size: number;
  points: InkPoint[];
}

export interface InkState {
  width: number;
  height: number;
  strokes: InkStroke[];
}

export interface PracticeChoiceOption {
  id: string;
  text: string;
}

export interface PracticeQuestionBase {
  id: PracticeQuestionId;
  type: PracticeQuestionType;
  prompt: string; // markdown
  points: number;
  explanation?: string; // markdown
}

export interface PracticeMultipleChoiceQuestion extends PracticeQuestionBase {
  type: "multiple_choice";
  options: PracticeChoiceOption[];
  correctOptionId: string;
}

export interface PracticeTextQuestion extends PracticeQuestionBase {
  type: "calculation" | "proof" | "qa";
  referenceAnswer: string; // markdown
}

export type PracticeQuestion = PracticeMultipleChoiceQuestion | PracticeTextQuestion;

export type PracticeAnswer =
  | { kind: "choice"; optionId: string }
  | { kind: "text"; text: string }
  | { kind: "ink"; ink: InkState; summaryText?: string };

export interface PracticeGrading {
  score: number;
  maxScore: number;
  explanation: string; // markdown
  gradedAt: number;
  model?: string;
}

export interface PracticeQuestionProgress {
  answer?: PracticeAnswer;
  grading?: PracticeGrading;
  submittedAt?: number;
}

export interface PracticeQuizProgress {
  byQuestionId: Record<PracticeQuestionId, PracticeQuestionProgress>;
}

export interface PracticeQuiz {
  id: PracticeQuizId;
  title: string;
  createdAt: number;
  updatedAt: number;
  questions: PracticeQuestion[];
  progress?: PracticeQuizProgress;
}

