export type PracticeQuestionType = "multiple_choice" | "calculation" | "proof" | "qa";

export type PracticeQuizId = string;
export type PracticeQuestionId = string;

export type InkStrokeId = string;

export type InkToolKind = "pen" | "pencil" | "eraser";

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
  brushId?: string;
  opacity?: number;
  pressureSensitivity?: number;
  blendMode?: "source-over" | "multiply";
  lineCap?: "round" | "butt" | "square";
  lineJoin?: "round" | "bevel" | "miter";
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

export interface PracticeAnswerImage {
  id: string;
  url: string;
  name?: string;
  width?: number;
  height?: number;
}

export type PracticeAnswer =
  | { kind: "choice"; optionId: string }
  | { kind: "text"; text: string }
  | { kind: "ink"; ink: InkState; summaryText?: string; images?: PracticeAnswerImage[] };

export interface PracticeGrading {
  score: number;
  maxScore: number;
  explanation: string; // markdown
  gradedAt: number;
  model?: string;
}

export interface PracticeQuizGrading extends PracticeGrading {
  totalQuestions: number;
  gradedQuestions: number;
}

export interface PracticeQuestionProgress {
  answer?: PracticeAnswer;
  grading?: PracticeGrading;
  submittedAt?: number;
}

export interface PracticeQuizProgress {
  byQuestionId: Record<PracticeQuestionId, PracticeQuestionProgress>;
  quizGrading?: PracticeQuizGrading;
}

export interface PracticeQuiz {
  id: PracticeQuizId;
  title: string;
  createdAt: number;
  updatedAt: number;
  questions: PracticeQuestion[];
  progress?: PracticeQuizProgress;
}
