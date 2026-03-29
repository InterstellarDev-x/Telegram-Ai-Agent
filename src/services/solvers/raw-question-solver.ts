import type { SupervisorRunResult } from "../../contracts/agents.ts";
import type {
  ParsedProblemBlueprint,
  RawQuestionRequest,
  StreamedSolveRequest,
} from "../../contracts/http.ts";
import { parseRawQuestionToBlueprint } from "../parsing/problem-blueprint-agent.ts";
import { solveWithFunctionHarness } from "./function-harness-solver.ts";
import type { Logger } from "../../utils/logger.ts";

export interface RawQuestionSolveResult {
  blueprint: ParsedProblemBlueprint;
  solveRequest: StreamedSolveRequest;
  result: SupervisorRunResult;
}

export async function solveRawQuestion(
  request: RawQuestionRequest,
  logger: Logger,
): Promise<RawQuestionSolveResult> {
  const blueprint = await parseRawQuestionToBlueprint(request, logger.child("parser"));

  if (!blueprint.suggestedSolveRequest) {
    throw new Error(
      "Could not deterministically build a solve request from the raw question.",
    );
  }

  const solveRequest: StreamedSolveRequest = {
    ...blueprint.suggestedSolveRequest,
    maxAttempts: request.maxAttempts,
  };

  const result = await solveWithFunctionHarness(solveRequest, logger.child("solver"));

  return {
    blueprint,
    solveRequest,
    result,
  };
}
