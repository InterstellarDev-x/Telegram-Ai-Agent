import type { CodingProblem } from "../contracts/problem.ts";
import { buildProblemFromRawText } from "../services/problem-normalizer.ts";

export function createDemoProblem(): CodingProblem {
  return buildProblemFromRawText({
    targetLanguage: "javascript",
    rawText: `
Add Two Integers

Given two integers a and b, print their sum.

Input Format
The input consists of two space-separated integers on a single line.

Output Format
Print a single integer equal to a + b.

Sample Input 1:
4 7
Sample Output 1:
11
    `.trim(),
    verificationCases: [
      {
        name: "hidden-negative-values",
        input: "-5 2",
        expectedOutput: "-3",
        source: "hidden",
        rationale: "Catches implementations that incorrectly force non-negative results.",
      },
      {
        name: "hidden-zero",
        input: "0 0",
        expectedOutput: "0",
        source: "hidden",
        rationale: "Validates neutral elements.",
      },
    ],
  });
}
