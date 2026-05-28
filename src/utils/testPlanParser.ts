/**
 * Parse a generated test-plan markdown document into structured test cases.
 *
 * The LLM produces a markdown table with columns roughly like:
 *   | TC-ID | Title / Name | Steps | Expected Result | Priority |
 * but column order and labels vary. We use header-name matching with
 * fuzzy aliases rather than fixed positional indexing.
 */

export interface ParsedTestCase {
  tcId: string;
  name: string;
  steps: string[];
  expectedResult: string;
  priority: string;
  testData?: string;
  preconditions?: string;
}

const HEADER_ALIASES: Record<keyof ParsedTestCase | 'jiraKey', RegExp> = {
  tcId: /^(tc[\s-_]?id|test[\s-_]?case[\s-_]?id|id|tc#?)$/i,
  // "Test Case Name", "Test Name", "Case Name" all need to count as the name
  // column — otherwise the positional fallback below kicks in and shuffles
  // every other column.
  name: /^(name|title|test[\s-_]?case([\s-_]?name)?|test[\s-_]?name|case([\s-_]?name)?|scenario|description)$/i,
  steps: /^(steps?|test[\s-_]?steps?|procedure)$/i,
  expectedResult: /^(expected([\s-_]?result)?|expected[\s-_]?output|expected[\s-_]?behavior)$/i,
  priority: /^(priority|severity)$/i,
  testData: /^(test[\s-_]?data|input|inputs|data)$/i,
  preconditions: /^(pre[\s-_]?conditions?|prerequisites?|setup)$/i,
  jiraKey: /^(jira([\s-_]?key)?|issue[\s-_]?key|story)$/i,
};

const splitMarkdownRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/**
 * Find the index of the first markdown table in the plan. Returns -1 if none.
 */
const findTableStart = (lines: string[]): number => {
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    // Header row followed by a separator row of |---|---|---|
    if (a.startsWith('|') && /^\|?\s*:?-{2,}/.test(b)) return i;
  }
  return -1;
};

export const parseTestPlanMarkdown = (markdown: string): ParsedTestCase[] => {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const tableStart = findTableStart(lines);
  if (tableStart === -1) return [];

  const headerCells = splitMarkdownRow(lines[tableStart]);
  const colIndex: Partial<Record<keyof ParsedTestCase, number>> = {};
  headerCells.forEach((h, idx) => {
    for (const key of Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]) {
      if (HEADER_ALIASES[key].test(h.replace(/\*/g, ''))) {
        // Only set the first match — table headers can repeat aliases
        if (key === 'jiraKey') continue;
        if (colIndex[key as keyof ParsedTestCase] === undefined) {
          colIndex[key as keyof ParsedTestCase] = idx;
        }
      }
    }
  });

  // Positional fallback for any column we couldn't identify by header.
  // CRITICAL: only fill MISSING entries — never overwrite a header match.
  // (Earlier this branch unconditionally clobbered already-detected columns
  // whenever `name` was missing, which shuffled Priority/Steps/Expected for
  // tables with a "Test Case Name" header.)
  if (colIndex.name === undefined) {
    if (colIndex.tcId === undefined) colIndex.tcId = 0;
    colIndex.name = colIndex.tcId === 0 ? 1 : 0;
    if (headerCells.length >= 4 && colIndex.steps === undefined) colIndex.steps = 2;
    if (headerCells.length >= 5 && colIndex.expectedResult === undefined) colIndex.expectedResult = 3;
    if (headerCells.length >= 6 && colIndex.priority === undefined) colIndex.priority = 4;
  }

  const out: ParsedTestCase[] = [];
  for (let i = tableStart + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break; // table ended
    const cells = splitMarkdownRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // skip stray separators

    const cellAt = (k: keyof ParsedTestCase) =>
      colIndex[k] !== undefined ? (cells[colIndex[k]!] || '').replace(/<br\s*\/?>/gi, '\n').trim() : '';

    const stepsRaw = cellAt('steps');
    const steps = stepsRaw
      ? stepsRaw
          .split(/\n|(?<=\.)\s+(?=\d+\.\s)|(?<=^|\n)\s*-\s+/g)
          .map((s) => s.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').trim())
          .filter(Boolean)
      : [];

    out.push({
      tcId: cellAt('tcId') || `TC-${out.length + 1}`,
      name: cellAt('name') || `Test Case ${out.length + 1}`,
      steps,
      expectedResult: cellAt('expectedResult'),
      priority: cellAt('priority') || 'Medium',
      testData: cellAt('testData') || undefined,
      preconditions: cellAt('preconditions') || undefined,
    });
  }
  return out;
};
