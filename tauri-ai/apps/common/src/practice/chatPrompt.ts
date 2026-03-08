import type { PracticeQuestion } from './types';

export function buildPracticeQuestionChatPrompt(question: PracticeQuestion): string {
  const sections = ['解答题目', question.prompt.trim() || '（题目为空）'];
  if (question.type === 'multiple_choice' && question.options.length > 0) {
    sections.push('', ...question.options.map((option) => `${option.id}. ${option.text.trim() || '（空）'}`));
  }
  return sections.join('\n').trim();
}
