import { execa } from "execa";
import { createInterface } from "node:readline";

let gumCached: boolean | undefined;

export async function hasGum(): Promise<boolean> {
  if (gumCached !== undefined) {
    return gumCached;
  }
  try {
    await execa("which", ["gum"]);
    gumCached = true;
  } catch {
    gumCached = false;
  }
  return gumCached;
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function uiChoose(
  title: string,
  choices: string[],
): Promise<string> {
  if (choices.length === 0) {
    throw new Error("uiChoose called with empty choices array");
  }

  if (await hasGum()) {
    const result = await execa("gum", ["choose", "--header", title, ...choices]);
    return result.stdout.trim();
  }

  // Fallback: numbered list on stdin
  process.stderr.write(`${title}\n`);
  for (let i = 0; i < choices.length; i++) {
    process.stderr.write(`  ${i + 1}) ${choices[i]}\n`);
  }

  const answer = await readLine("Choose [number]: ");
  const index = parseInt(answer, 10) - 1;

  if (index >= 0 && index < choices.length) {
    return choices[index] ?? choices[0] ?? "";
  }
  // Default to first choice on invalid input
  return choices[0] ?? "";
}

export async function uiConfirm(question: string): Promise<boolean> {
  if (await hasGum()) {
    try {
      await execa("gum", ["confirm", question]);
      return true;
    } catch {
      return false;
    }
  }

  const answer = await readLine(`${question} [y/N]: `);
  return answer.toLowerCase().startsWith("y");
}

export async function uiInput(
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  if (await hasGum()) {
    const args: string[] = ["input", "--placeholder", prompt];
    if (defaultValue !== undefined) {
      args.push("--value", defaultValue);
    }
    const result = await execa("gum", args);
    return result.stdout.trim();
  }

  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  const answer = await readLine(`${prompt}${suffix}: `);
  if (answer.trim() === "" && defaultValue !== undefined) {
    return defaultValue;
  }
  return answer;
}

export async function uiSpinner<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (await hasGum()) {
    const resultPromise = fn();

    // Start the spinner as a background process
    const spinner = execa("gum", ["spin", "--title", title, "--", "sleep", "86400"], {
      reject: false,
    });

    try {
      const result = await resultPromise;
      return result;
    } finally {
      spinner.kill();
    }
  }

  process.stderr.write(`${title}...\n`);
  return fn();
}

export function uiInfo(message: string): void {
  console.log(message);
}

export function uiError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

export function uiWarn(message: string): void {
  process.stderr.write(`WARN: ${message}\n`);
}

export function uiSuccess(message: string): void {
  console.log(`OK: ${message}`);
}
