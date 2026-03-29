import { CallbackLogger } from "./utils/logger.ts";
import { createSseResponse, SseEventStream } from "./services/streaming/sse.ts";
import {
  rawQuestionRequestSchema,
  streamedSolveRequestSchema,
  type RawQuestionRequest,
  type StreamedSolveRequest,
} from "./contracts/http.ts";
import { solveWithFunctionHarness } from "./services/solvers/function-harness-solver.ts";
import { parseRawQuestionToBlueprint } from "./services/parsing/problem-blueprint-agent.ts";
import { solveRawQuestion } from "./services/solvers/raw-question-solver.ts";
import {
  processTelegramUpdate,
  validateTelegramWebhookRequest,
} from "./services/telegram/telegram-webhook.ts";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  idleTimeout: 255,
  routes: {
    "/health": new Response(
      JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    ),
    "/telegram/health": new Response(
      JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
        webhookPath: "/telegram/webhook",
        telegramBotConfigured: Boolean(
          process.env.TELEGRAM_BOT_TOKEN ??
            "8599626908:AAFXItwarN2ZkvXQGiPbwX9xami2tLmHZv8",
        ),
        openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    ),
  },
  fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/solve/stream") {
      return handleStreamSolve(request);
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/solve/from-text/stream") {
      return handleStreamSolveFromText(request);
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/parse/problem") {
      return handleParseProblem(request);
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    message: "server-started",
    port: server.port,
    date: new Date().toISOString(),
  }),
);

async function handleStreamSolve(request: Request): Promise<Response> {
  const body = await safeReadJson(request);
  const parsed = streamedSolveRequestSchema.safeParse(body);

  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
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
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
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
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const logger = new CallbackLogger("parser-api", () => {});
  const blueprint = await parseRawQuestionToBlueprint(parsed.data, logger);

  return new Response(JSON.stringify(blueprint), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleTelegramWebhook(request: Request): Promise<Response> {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return new Response(
        JSON.stringify({
          error: "TELEGRAM_BOT_TOKEN is not configured.",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const update = await validateTelegramWebhookRequest(request);
    const logger = new CallbackLogger("telegram-webhook", (entry) => {
      console.log(JSON.stringify(entry));
    });

    void processTelegramUpdate(update, logger).catch((error) => {
      logger.error("telegram-background-processing-failed", {
        reason: error instanceof Error ? error.message : "unknown-error",
      });
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Invalid Telegram webhook",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
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
