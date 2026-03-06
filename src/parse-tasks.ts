type PlanTask = { title: string; description: string; priority?: string; type?: string; dependsOn?: number[] };

/**
 * Extract a JSON array of task objects from Claude's plan response.
 * Tries three strategies in order: code-block extraction, bracket-matching, greedy regex.
 * Returns null if no valid array is found.
 */
export function extractTaskArray(output: string): PlanTask[] | null {
  const candidates: string[] = [];

  // 1. Code block extraction (non-greedy)
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim());
  }

  // 2. Bracket-matching: find first '[' and count depth to find its matching ']'
  // This avoids the greedy regex overshooting when response has [bracketed] prose after the JSON.
  const firstBracket = output.indexOf("[");
  if (firstBracket !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBracket; i < output.length; i++) {
      const ch = output[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "[") depth++;
      if (ch === "]") { depth--; if (depth === 0) { candidates.push(output.slice(firstBracket, i + 1)); break; } }
    }
  }

  // 3. Greedy fallback (original approach)
  const greedyMatch = output.match(/\[[\s\S]*\]/);
  if (greedyMatch) {
    candidates.push(greedyMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const p: unknown = JSON.parse(candidate);
      if (Array.isArray(p) && p.length > 0) return p as PlanTask[];
    } catch { continue; }
  }

  return null;
}
