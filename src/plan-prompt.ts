/**
 * JSON schema instruction included in all planning prompts.
 * Tells Claude which fields to produce for each task, including the "group"
 * field used for auto-clustering tasks into goals.
 *
 * Extracted to a standalone module (rather than living inside the CLI entrypoint)
 * so that tests can import it without triggering Commander's `program.parse()`.
 */
export const JSON_SCHEMA_INSTRUCTION =
  `Return ONLY a JSON array of objects with "title", "description", "priority", "group", and optionally "dependsOn" fields.\n` +
  `Priority must be one of: "critical", "high", "medium", "low".\n` +
  `"group" is a short label (2-4 words) for the functional area this task belongs to (e.g. "Git Integration", "Budget System", "CLI Commands"). Tasks with the same group will be clustered into a goal.\n` +
  `If a task depends on another task in this list being completed first, include a "dependsOn" array with the 0-based indices of those prerequisite tasks (e.g. "dependsOn": [0, 2] means this task depends on the 1st and 3rd tasks). Tasks with no dependencies should omit this field or use an empty array.\n`;
