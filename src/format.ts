// Zero-dependency ANSI terminal formatting for markdown-like text.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";

let colorSupport: boolean | undefined;

export function supportsColor(): boolean {
  if (colorSupport !== undefined) return colorSupport;
  if (process.env["NO_COLOR"] !== undefined) { colorSupport = false; return false; }
  if (process.env["FORCE_COLOR"] !== undefined) { colorSupport = true; return true; }
  colorSupport = process.stderr.isTTY === true;
  return colorSupport;
}

export function bold(text: string): string {
  return supportsColor() ? `${BOLD}${text}${RESET}` : text;
}

export function dim(text: string): string {
  return supportsColor() ? `${DIM}${text}${RESET}` : text;
}

export function red(text: string): string {
  return supportsColor() ? `${RED}${text}${RESET}` : text;
}

export function green(text: string): string {
  return supportsColor() ? `${GREEN}${text}${RESET}` : text;
}

export function yellow(text: string): string {
  return supportsColor() ? `${YELLOW}${text}${RESET}` : text;
}

export function cyan(text: string): string {
  return supportsColor() ? `${CYAN}${text}${RESET}` : text;
}

export function blue(text: string): string {
  return supportsColor() ? `${BLUE}${text}${RESET}` : text;
}

/**
 * Applies ANSI formatting to a single complete line of markdown.
 * Handles headers, bold, inline code. Does not handle multi-line constructs.
 */
export function formatMarkdownLine(line: string): string {
  if (!supportsColor()) return line;
  if (line === "") return line;

  // Headers
  if (line.startsWith("### ")) return `${BOLD}${line}${RESET}`;
  if (line.startsWith("## ")) return `${BOLD}${line}${RESET}`;
  if (line.startsWith("# ")) return `${BOLD}${line}${RESET}`;

  // Horizontal rules
  if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) return `${DIM}${line}${RESET}`;

  let result = line;
  // Bold: **text** (non-greedy, must not span more than ~200 chars to avoid runaway)
  result = result.replace(/\*\*(.{1,200}?)\*\*/g, `${BOLD}$1${RESET}`);
  // Inline code: `text`
  result = result.replace(/`([^`\n]{1,200}?)`/g, `${CYAN}$1${RESET}`);

  return result;
}

/**
 * Line-buffered streaming markdown formatter.
 * Buffers text until complete lines are available, then formats them.
 * Handles code block regions (dims content, skips inline formatting).
 */
export class StreamFormatter {
  private buffer = "";
  private inCodeBlock = false;

  /** Feed a text delta. Returns formatted text ready for output (may be empty if buffering). */
  write(delta: string): string {
    if (!supportsColor()) return delta;

    this.buffer += delta;
    const lastNewline = this.buffer.lastIndexOf("\n");
    if (lastNewline === -1) return "";

    const complete = this.buffer.slice(0, lastNewline + 1);
    this.buffer = this.buffer.slice(lastNewline + 1);

    const lines = complete.split("\n");
    const formatted: string[] = [];
    for (const line of lines) {
      if (line.startsWith("```")) {
        this.inCodeBlock = !this.inCodeBlock;
        formatted.push(`${DIM}${line}${RESET}`);
      } else if (this.inCodeBlock) {
        formatted.push(`${DIM}${line}${RESET}`);
      } else {
        formatted.push(formatMarkdownLine(line));
      }
    }
    return formatted.join("\n");
  }

  /** Flush any remaining buffered text. Call on stream end or context switch. */
  flush(): string {
    if (this.buffer.length === 0) return "";
    const line = this.buffer;
    this.buffer = "";
    const wasInCodeBlock = this.inCodeBlock;
    this.inCodeBlock = false;
    if (!supportsColor()) return line;
    return wasInCodeBlock ? `${DIM}${line}${RESET}` : formatMarkdownLine(line);
  }
}
