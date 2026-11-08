import { QuestionError } from '../questions/types.ts';

export function isQuestionError(error: unknown): error is QuestionError {
  return error instanceof QuestionError;
}
