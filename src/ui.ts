import { execa } from "execa";
import { createInterface } from "node:readline";
import { bold, red, yellow, green, blue, dim } from "./format.js";

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
    const result = await execa("gum", ["choose", "--header", title, ...choices], {
      stdin: "inherit",
      stderr: "inherit",
    });
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

export async function uiChooseMultiple(
  title: string,
  choices: string[],
): Promise<string[]> {
  if (choices.length === 0) {
    return [];
  }

  if (await hasGum()) {
    const result = await execa(
      "gum",
      ["choose", "--no-limit", "--ordered", "--header", title, ...choices],
      {
        stdin: "inherit",
        stderr: "inherit",
      },
    );
    const selected = result.stdout.trim();
    if (selected === "") return [];
    return selected.split("\n");
  }

  // Fallback: numbered list, user enters comma-separated numbers in order
  process.stderr.write(`${title}\n`);
  for (let i = 0; i < choices.length; i++) {
    process.stderr.write(`  ${i + 1}) ${choices[i]}\n`);
  }

  const answer = await readLine("Enter numbers in priority order (comma-separated): ");
  const indices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < choices.length);

  return indices.map((i) => choices[i]!);
}

export async function uiConfirm(question: string): Promise<boolean> {
  if (await hasGum()) {
    try {
      await execa("gum", ["confirm", question], {
        stdin: "inherit",
        stderr: "inherit",
      });
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
    const result = await execa("gum", args, {
      stdin: "inherit",
      stderr: "inherit",
    });
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
    process.stderr.write(`  ${title}\n`);
    return fn();
  }

  process.stderr.write(`${title}...\n`);
  return fn();
}

export function uiInfo(message: string): void {
  // Highlight phase headers and key metrics
  if (/^Phase \d|^---/.test(message)) {
    console.log(bold(message));
  } else if (message.startsWith("Confidence:")) {
    console.log(blue(message));
  } else {
    console.log(message);
  }
}

export function uiError(message: string): void {
  process.stderr.write(`${red("ERROR:")} ${message}\n`);
}

export function uiWarn(message: string): void {
  process.stderr.write(`${yellow("WARN:")} ${message}\n`);
}

export function uiSuccess(message: string): void {
  console.log(`${green("OK:")} ${message}`);
}

export function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
