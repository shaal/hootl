/**
 * Multi-candidate JSON extraction from Claude's free-form text output.
 *
 * Three strategies, tried in order — the first that JSON.parse's wins:
 * 1. Code-block extraction (```json ... ```)
 * 2. Reverse brace-matching (last } backwards to matching {)
 * 3. Forward brace-matching (first { forwards to matching })
 *
 * Used by parseReviewResult, parsePreflightResult (loop.ts) and parseHookResult (hooks.ts).
 */
export function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];

  // Candidate 1: code-block extraction (```json ... ```)
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(output);
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim());
  }

  // Candidate 2: reverse brace-matching — find last }, walk backwards to matching {
  // This handles prose with stray { characters before the JSON block.
  const lastClose = output.lastIndexOf("}");
  if (lastClose !== -1) {
    let depth = 0;
    for (let i = lastClose; i >= 0; i--) {
      if (output[i] === "}") depth++;
      else if (output[i] === "{") {
        depth--;
        if (depth === 0) {
          candidates.push(output.slice(i, lastClose + 1));
          break;
        }
      }
    }
  }

  // Candidate 3: forward brace-matching (first { forwards to matching })
  const firstBrace = output.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    for (let i = firstBrace; i < output.length; i++) {
      if (output[i] === "{") depth++;
      else if (output[i] === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(output.slice(firstBrace, i + 1));
          break;
        }
      }
    }
  }

  return candidates;
}
