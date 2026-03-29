import type { CodingProblem, ProblemTestCase, SupportedLanguage } from "../contracts/problem.ts";

interface BuildProblemInput {
  rawText: string;
  targetLanguage?: SupportedLanguage;
  verificationCases?: ProblemTestCase[];
  constraints?: string[];
}

const SAMPLE_BLOCK_PATTERN =
  /Sample Input\s*\d*\s*:?\s*([\s\S]*?)\n\s*Sample Output\s*\d*\s*:?\s*([\s\S]*?)(?=\n\s*(?:Sample Input|Explanation|Constraints|$))/gi;

export function buildProblemFromRawText({
  rawText,
  targetLanguage = "javascript",
  verificationCases = [],
  constraints = [],
}: BuildProblemInput): CodingProblem {
  const statement = rawText.trim();
  const lines = statement
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines[0] ?? "Untitled Problem";

  const sampleCases = extractSampleCases(statement);

  return {
    id: crypto.randomUUID(),
    title,
    rawText: statement,
    statement,
    targetLanguage,
    sampleCases,
    verificationCases,
    constraints,
  };
}

export function extractSampleCases(rawText: string): ProblemTestCase[] {
  const cases: ProblemTestCase[] = [];
  let match: RegExpExecArray | null = null;
  let index = 1;

  while ((match = SAMPLE_BLOCK_PATTERN.exec(rawText)) !== null) {
    const input = match[1]?.trim();
    const output = match[2]?.trim();

    if (!input || !output) {
      continue;
    }

    cases.push({
      name: `sample-${index}`,
      input,
      expectedOutput: output,
      source: "sample",
      rationale: "Parsed from the extracted problem statement.",
    });
    index += 1;
  }

  return cases;
}
