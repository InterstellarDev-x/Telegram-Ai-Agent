import { describe, expect, test } from "bun:test";
import { parseRawQuestionToBlueprint } from "../src/services/parsing/problem-blueprint-agent.js";
import { MemoryLogger } from "../src/utils/logger.js";

describe("parseRawQuestionToBlueprint", () => {
  test("builds a deterministic function harness from OCR-style examples without a signature", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const blueprint = await parseRawQuestionToBlueprint(
        {
          question: `
Regular Expression Matching

Given an input string s and a pattern p, implement regular expression matching with support for '.' and '*' where:
'.' Matches any single character.
'*' Matches zero or more of the preceding element.
Return a boolean indicating whether the matching covers the entire input string (not partial).

Example 1:
Input: s = "aa", p = "a"
Output: false

Example 2:
Input: s = "aa", p = "a*"
Output: true

Example 3:
Input: s = "ab", p = ".*"
Output: true
          `.trim(),
          targetLanguage: "typescript",
          maxAttempts: 4,
          imageAssets: [],
          extractionWarnings: [],
        },
        new MemoryLogger("test"),
      );

      expect(blueprint.detectedStyle).toBe("function");
      expect(blueprint.functionName).toBe("isMatch");
      expect(blueprint.functionSignature).toBe(
        "function isMatch(s: string, p: string): boolean",
      );
      expect(blueprint.suggestedSolveRequest).toBeDefined();
      expect(blueprint.suggestedSolveRequest?.harness.tests).toHaveLength(3);
      expect(blueprint.suggestedSolveRequest?.harness.invokeExpression).toBe(
        "isMatch(testCase.input.s, testCase.input.p)",
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  test("builds a stdin/stdout solve request from competitive-programming case blocks", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const blueprint = await parseRawQuestionToBlueprint(
        {
          question: `
Emil's Special Longes

You are given two strings A and B consisting of lowercase English letters.

Emil defines the score of a common subsequence as:
score = (length of the subsequence) x (number of occurrences of 'e')

Find the maximum score.

Input Format
The first line contains a string, A.
The next line contains a string, B.

Constraints
1 <= len(A) <= 500
1 <= len(B) <= 500

Sample Test Cases
Case 1
Input:
eeee
eee
Output:
9

Explanation:
We select the common subsequence 'eee'.

Case 2
Input:
abcde
ace
Output:
3
          `.trim(),
          targetLanguage: "cpp",
          maxAttempts: 4,
          imageAssets: [],
          extractionWarnings: [],
        },
        new MemoryLogger("test"),
      );

      expect(blueprint.detectedStyle).toBe("stdin_stdout");
      expect(blueprint.suggestedSolveRequest).toBeDefined();
      expect(blueprint.suggestedSolveRequest?.targetLanguage).toBe("cpp");
      expect(blueprint.suggestedSolveRequest?.harness.tests).toHaveLength(2);
      expect(blueprint.suggestedSolveRequest?.harness.tests[0]?.input).toEqual({
        stdin: "eeee\neee",
      });
      expect(blueprint.suggestedSolveRequest?.harness.tests[0]?.expected).toBe("9");
      expect(blueprint.suggestedSolveRequest?.instructions).toContain(
        "Solve this as a stdin/stdout competitive-programming problem.",
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  test("builds a stdin/stdout solve request from codeforces-style example blocks", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const blueprint = await parseRawQuestionToBlueprint(
        {
          question: `
A. Friendly Numbers
time limit per test: 1 second
memory limit per test: 256 megabytes

For a given integer x, determine how many friendly numbers it has.

Input
Each test contains multiple test cases. The first line contains the number of test cases t (1 <= t <= 500).
Each test case consists of a single line containing one integer x (1 <= x <= 10^9).

Output
For each test case, output one integer — the answer to the problem.

Example
input
3
1
18
998244360
output
0
10
10

Note
The number 1 does not have any friendly numbers.
          `.trim(),
          targetLanguage: "cpp",
          maxAttempts: 4,
          imageAssets: [],
          extractionWarnings: [],
        },
        new MemoryLogger("test"),
      );

      expect(blueprint.detectedStyle).toBe("stdin_stdout");
      expect(blueprint.suggestedSolveRequest).toBeDefined();
      expect(blueprint.suggestedSolveRequest?.harness.tests).toHaveLength(1);
      expect(blueprint.suggestedSolveRequest?.harness.tests[0]?.input).toEqual({
        stdin: "3\n1\n18\n998244360",
      });
      expect(blueprint.suggestedSolveRequest?.harness.tests[0]?.expected).toBe(
        "0\n10\n10",
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });
});
