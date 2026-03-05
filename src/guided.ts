import { invokeClaude } from "./invoke.js";
import { uiChoose, uiInput, uiInfo } from "./ui.js";

export interface ClarifyingQuestion {
  question: string;
  options: string[];
}

const CLARIFICATION_SYSTEM_PROMPT =
  `You are a goal clarification assistant for a task planner. ` +
  `Given a user's goal and project context, generate 2-4 clarifying questions that resolve ambiguities and design decisions. ` +
  `Rules:\n` +
  `- Focus on choices that materially affect implementation (architecture, behavior, scope)\n` +
  `- Skip anything obvious from the goal or context\n` +
  `- Each question must have 2-4 concrete answer options\n` +
  `- The last option for every question must be "Custom answer"\n` +
  `- Keep questions concise — one sentence each\n` +
  `- Cap at 4 questions maximum\n\n` +
  `Return ONLY a JSON array of objects with "question" (string) and "options" (string array) fields. No other text.`;

export function buildClarificationPrompt(goal: string, context: string): string {
  return (
    `Goal: ${goal}\n\n` +
    `<context>\n${context}\n</context>\n\n` +
    `Generate clarifying questions for this goal.`
  );
}

export function parseClarifyingQuestions(output: string): ClarifyingQuestion[] {
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (jsonMatch === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const questions: ClarifyingQuestion[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["question"] === "string" &&
      Array.isArray((item as Record<string, unknown>)["options"])
    ) {
      const record = item as Record<string, unknown>;
      const options = (record["options"] as unknown[]).filter(
        (o): o is string => typeof o === "string",
      );
      if (options.length >= 2) {
        questions.push({
          question: record["question"] as string,
          options,
        });
      }
    }
  }

  return questions.slice(0, 4);
}

export async function generateClarifyingQuestions(
  goal: string,
  context: string,
  verbose?: boolean,
): Promise<ClarifyingQuestion[]> {
  const prompt = buildClarificationPrompt(goal, context);
  const result = await invokeClaude({
    prompt,
    systemPrompt: CLARIFICATION_SYSTEM_PROMPT,
    verbose,
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return parseClarifyingQuestions(result.output);
}

export async function collectAnswers(
  questions: ClarifyingQuestion[],
): Promise<string[]> {
  const answers: string[] = [];

  for (const q of questions) {
    uiInfo(`\n${q.question}`);
    const choice = await uiChoose("Select an answer:", q.options);

    if (choice === "Custom answer") {
      const custom = await uiInput("Your answer:");
      answers.push(custom);
    } else {
      answers.push(choice);
    }
  }

  return answers;
}

export function formatConstraints(
  questions: ClarifyingQuestion[],
  answers: string[],
): string {
  const lines: string[] = ["\nClarified constraints:"];
  for (let i = 0; i < questions.length && i < answers.length; i++) {
    lines.push(`- Q: ${questions[i]!.question}`);
    lines.push(`  A: ${answers[i]}`);
  }
  return lines.join("\n");
}
