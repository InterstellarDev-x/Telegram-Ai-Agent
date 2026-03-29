import { CallbackLogger } from "./utils/logger.js";
import { createSseResponse, SseEventStream } from "./services/streaming/sse.js";
import {
  rawQuestionRequestSchema,
  streamedSolveRequestSchema,
  type RawQuestionRequest,
  type StreamedSolveRequest,
} from "./contracts/http.js";

export async function handleHttpRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method === "GET" && pathname === "/health") {
    return jsonResponse({
      ok: true,
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && pathname === "/telegram/health") {
    return jsonResponse({
      ok: true,
      timestamp: new Date().toISOString(),
      webhookPath: "/telegram/webhook",
      telegramBotConfigured: Boolean(
        process.env.TELEGRAM_BOT_TOKEN ??
          "8599626908:AAFXItwarN2ZkvXQGiPbwX9xami2tLmHZv8",
      ),
      upstashConfigured: Boolean(
        process.env.UPSTASH_REDIS_REST_URL ??
          "https://pure-rabbit-71049.upstash.io",
      ),
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
    });
  }

  if (request.method === "POST" && pathname === "/solve/stream") {
    return await handleStreamSolve(request);
  }

  if (request.method === "POST" && pathname === "/solve/from-text/stream") {
    return await handleStreamSolveFromText(request);
  }

  if (request.method === "POST" && pathname === "/parse/problem") {
    return await handleParseProblem(request);
  }

  if (request.method === "POST" && pathname === "/telegram/webhook") {
    return await handleTelegramWebhook(request);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleStreamSolve(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = streamedSolveRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const stream = new SseEventStream();
  void runSolve(parsed.data, stream);
  return createSseResponse(stream.stream);
}

async function handleStreamSolveFromText(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = rawQuestionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const stream = new SseEventStream();
  void runSolveFromText(parsed.data, stream);
  return createSseResponse(stream.stream);
}

async function handleParseProblem(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = rawQuestionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(
      {
        error: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const logger = new CallbackLogger("parser-api", () => {});
  const { parseRawQuestionToBlueprint } = await import(
    "./services/parsing/problem-blueprint-agent.js"
  );
  const blueprint = await parseRawQuestionToBlueprint(parsed.data, logger);
  return jsonResponse(blueprint);
}

async function handleTelegramWebhook(request: Request): Promise<Response> {
  try {
    const telegramBotToken =
      process.env.TELEGRAM_BOT_TOKEN ??
      "8599626908:AAFXItwarN2ZkvXQGiPbwX9xami2tLmHZv8";

    if (!telegramBotToken) {
      return jsonResponse(
        {
          error: "TELEGRAM_BOT_TOKEN is not configured.",
        },
        503,
      );
    }

    const { processTelegramUpdate, validateTelegramWebhookRequest } = await import(
      "./services/telegram/telegram-webhook.js"
    );
    const update = await validateTelegramWebhookRequest(request);
    const logger = new CallbackLogger("telegram-webhook", (entry) => {
      console.log(JSON.stringify(entry));
    });

    await processTelegramUpdate(update, logger);

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Invalid Telegram webhook",
      },
      400,
    );
  }
}

async function runSolve(
  request: StreamedSolveRequest,
  stream: SseEventStream,
): Promise<void> {
  const logger = new CallbackLogger("solver-api", (entry) => {
    stream.emit("log", entry);
  });

  stream.emit("accepted", {
    title: request.title,
    maxAttempts: request.maxAttempts,
    functionName: request.harness.functionName,
  });

  try {
    const { solveWithFunctionHarness } = await import(
      "./services/solvers/function-harness-solver.js"
    );
    const result = await solveWithFunctionHarness(request, logger);

    stream.emit("result", {
      status: result.status,
      attemptsUsed: result.attemptsUsed,
      finalCandidate: result.finalCandidate,
      finalReport: result.finalReport,
      transcript: result.transcript,
    });
    stream.close();
  } catch (error) {
    stream.error(error);
  }
}

async function runSolveFromText(
  request: RawQuestionRequest,
  stream: SseEventStream,
): Promise<void> {
  const logger = new CallbackLogger("solver-text-api", (entry) => {
    stream.emit("log", entry);
  });

  stream.emit("accepted", {
    title: "raw-question",
    maxAttempts: request.maxAttempts,
  });

  try {
    const { solveRawQuestion } = await import("./services/solvers/raw-question-solver.js");
    const outcome = await solveRawQuestion(request, logger);
    const { blueprint, result } = outcome;
    stream.emit("parsed_problem", blueprint);

    stream.emit("result", {
      status: result.status,
      attemptsUsed: result.attemptsUsed,
      finalCandidate: result.finalCandidate,
      finalReport: result.finalReport,
      transcript: result.transcript,
      blueprint,
    });
    stream.close();
  } catch (error) {
    stream.error(error);
  }
}

async function safeReadJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
