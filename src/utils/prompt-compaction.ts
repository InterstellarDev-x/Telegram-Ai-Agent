import type { GenerationFeedback, SolutionCandidate } from "../contracts/agents.js";
import type { ProblemTestCase } from "../contracts/problem.js";

const EXECUTION_REQUIREMENTS_MARKER = "\nExecution requirements:";

export function stripExecutionRequirements(statement: string): string {
  const markerIndex = statement.indexOf(EXECUTION_REQUIREMENTS_MARKER);
  if (markerIndex < 0) {
    return statement.trim();
  }

  return statement.slice(0, markerIndex).trim();
}

export function compactProblemStatement(
  statement: string,
  maxChars = 8_000,
): string {
  return truncateMiddle(stripExecutionRequirements(statement), maxChars);
}

export function formatSampleCases(
  cases: ProblemTestCase[],
  {
    maxCases = 3,
    maxInputChars = 250,
    maxOutputChars = 250,
  }: {
    maxCases?: number;
    maxInputChars?: number;
    maxOutputChars?: number;
  } = {},
): string {
  if (cases.length === 0) {
    return "No parsed sample cases available.";
  }

  const visible = cases.slice(0, maxCases);
  const blocks = visible.map(
    (testCase, index) => `Case ${index + 1} (${testCase.source})
input:
${truncateMiddle(testCase.input, maxInputChars)}
expected:
${truncateMiddle(testCase.expectedOutput, maxOutputChars)}`,
  );

  if (cases.length > visible.length) {
    blocks.push(`... ${cases.length - visible.length} additional sample case(s) omitted.`);
  }

  return blocks.join("\n\n");
}

export function formatFeedbackHistory(
  feedbackHistory: GenerationFeedback[],
  detailedLimit = 2,
): string {
  if (feedbackHistory.length === 0) {
    return "No prior tester feedback.";
  }

  const detailed = feedbackHistory.slice(-detailedLimit);
  const omittedCount = Math.max(0, feedbackHistory.length - detailed.length);
  const sections: string[] = [];

  if (omittedCount > 0) {
    sections.push(
      `Older feedback summary (${omittedCount} omitted): ${feedbackHistory
        .slice(0, omittedCount)
        .map((feedback, index) => `${index + 1}. ${truncateInline(feedback.rootCause, 120)}`)
        .join(" | ")}`,
    );
  }

  sections.push(
    ...detailed.map(
      (feedback, index) => `Recent feedback ${index + 1}:
summary: ${truncateMiddle(feedback.summary, 300)}
rootCause: ${truncateMiddle(feedback.rootCause, 220)}
actionItems:
${feedback.actionItems
  .slice(0, 4)
  .map((item) => `- ${truncateInline(item, 160)}`)
  .join("\n")}`,
    ),
  );

  return sections.join("\n\n");
}

export function formatPreviousCandidates(
  previousCandidates: SolutionCandidate[],
  {
    latestCodeChars = 6_000,
  }: {
    latestCodeChars?: number;
  } = {},
): string {
  if (previousCandidates.length === 0) {
    return "No prior failed code.";
  }

  const latest = previousCandidates[previousCandidates.length - 1];
  if (!latest) {
    return "No prior failed code.";
  }
  const older = previousCandidates.slice(0, -1);
  const sections: string[] = [];

  if (older.length > 0) {
    sections.push(
      `Older candidate summary (${older.length} omitted): ${older
        .map(
          (candidate, index) =>
            `${index + 1}. ${candidate.provider ?? "unknown"} / ${truncateInline(candidate.strategy, 120)} / ${truncateInline(candidate.complexity, 80)}`,
        )
        .join(" | ")}`,
    );
  }

  sections.push(`Latest failed candidate:
provider: ${latest.provider ?? "unknown"}
language: ${latest.language}
strategy: ${truncateMiddle(latest.strategy, 300)}
complexity: ${truncateInline(latest.complexity, 120)}
code:
${truncateMiddle(latest.code, latestCodeChars)}`);

  return sections.join("\n\n");
}

export function formatWarnings(
  warnings: string[],
  maxWarnings = 6,
): string {
  if (warnings.length === 0) {
    return "No extraction warnings.";
  }

  const visible = warnings
    .slice(0, maxWarnings)
    .map((warning) => `- ${truncateInline(warning, 180)}`);
  if (warnings.length > maxWarnings) {
    visible.push(`- ${warnings.length - maxWarnings} more warning(s) omitted.`);
  }

  return visible.join("\n");
}

export function estimatePromptChars(...parts: string[]): number {
  return parts.reduce((sum, part) => sum + part.length, 0);
}

export function truncateMiddle(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars <= 120) {
    return `${normalized.slice(0, maxChars - 16)}\n...[truncated]`;
  }

  const headLength = Math.floor(maxChars * 0.65);
  const tailLength = Math.max(40, maxChars - headLength - 24);
  return `${normalized.slice(0, headLength).trimEnd()}\n...[truncated]...\n${normalized
    .slice(-tailLength)
    .trimStart()}`;
}

export function truncateInline(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}
