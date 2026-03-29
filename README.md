# Telegram AI Coding Agent

A Bun + TypeScript backend that acts as a Telegram bot for solving competitive-programming and exam-style coding problems from screenshots.

## How it works

1. **Image collection** – You send one or more screenshots of a coding problem to the Telegram bot.
2. **OCR / extraction** – The bot downloads each image and uses an OpenAI Vision or Gemini vision model to extract the problem statement, constraints, examples, and any starter template.
3. **Problem parsing** – A parser agent converts the extracted text into a structured problem blueprint (title, statement, I/O format, sample tests, function harness).
4. **Supervisor solve loop** – A `SupervisorAgent` orchestrates up to N attempts:
   - A **code-generation agent** (OpenAI GPT-4 or Gemini) produces a candidate solution.
   - A **code-testing agent** executes the candidate against hidden verifier tests (supports `cpp`, `typescript`, `javascript`, `python`).
   - If tests fail the tester produces structured feedback (root cause, action items) and the generator retries.
5. **Reply** – The bot sends the verified solution back to the Telegram chat as a formatted code block.
6. **Follow-up feedback loop** – After receiving code you can send error screenshots or text notes, then trigger a re-solve with the additional context.

## Supported languages

`cpp` · `typescript` · `javascript` · `python`

## Install

```bash
bun install
```

## Run the server

```bash
bun run serve
```

The HTTP server listens on port `3000` by default.

## Run the demo (no API keys required)

```bash
bun run demo
```

The demo uses scripted (mock) agents to show the full generator → tester → retry loop without calling any LLM API.

## Run tests

```bash
bun test
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | For OpenAI features | API key for GPT-4 code generation and vision OCR |
| `OPENAI_MODEL` | No (default `gpt-4.1`) | Chat model used for code generation |
| `OPENAI_VISION_MODEL` | No (default `gpt-4.1`) | Vision model used for OCR / image extraction |
| `GEMINI_API_KEY` | For Gemini features | API key for Gemini code generation |
| `GEMINI_MODEL` | No (default `gemini-2.5-flash`) | Gemini model used for code generation |
| `TELEGRAM_BOT_TOKEN` | For Telegram bot | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | No | Optional shared secret to validate webhook calls |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis URL for persistent session storage |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis token for persistent session storage |

## Telegram bot setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Set `TELEGRAM_BOT_TOKEN` and other env vars.
3. Start the server and expose it (e.g. with [ngrok](https://ngrok.com/)).
4. Register your webhook with Telegram:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-host/telegram/webhook"
```

### Telegram chat commands

| Message | Action |
|---|---|
| `1` | Start collecting problem images |
| (send images) | Add screenshots to the current collection queue |
| `2` | Stop collecting and start OCR + solve |
| `status` | Show the current session state |
| `4` | Mark problem as done and clear the session |
| `5` | Reset the session without marking as done |

After the bot sends a solution you can send error screenshots or explanatory text, then send `2` again to trigger a repair pass with that feedback.

## HTTP API

All endpoints accept and return `application/json`. The `/solve/*` endpoints stream [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events).

### `GET /health`

Returns `{ ok: true, timestamp }`.

### `GET /telegram/health`

Returns the configuration status of Telegram, OpenAI, Gemini, and Upstash Redis.

### `POST /solve/stream`

Solve a fully structured problem. Streams `log`, `accepted`, and `result` SSE events.

```bash
curl -N -X POST http://localhost:3000/solve/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Regular Expression Matching",
    "statement": "Implement regular expression matching with support for . and * over the entire string.",
    "targetLanguage": "typescript",
    "instructions": [
      "The function must be named isMatch.",
      "The signature is function isMatch(s: string, p: string): boolean."
    ],
    "maxAttempts": 4,
    "harness": {
      "functionName": "isMatch",
      "functionSignature": "function isMatch(s: string, p: string): boolean",
      "invokeExpression": "isMatch(testCase.input.s, testCase.input.p)",
      "assertionExpression": "actual === testCase.expected",
      "prelude": "",
      "tests": [
        { "name": "sample-1", "input": { "s": "aa", "p": "a" }, "expected": false, "source": "sample" },
        { "name": "sample-2", "input": { "s": "aa", "p": "a*" }, "expected": true, "source": "sample" },
        { "name": "sample-3", "input": { "s": "ab", "p": ".*" }, "expected": true, "source": "sample" }
      ]
    }
  }'
```

### `POST /solve/from-text/stream`

Parse raw question text and solve it in one call. Streams `log`, `accepted`, `parsed_problem`, and `result` SSE events.

```bash
curl -N -X POST http://localhost:3000/solve/from-text/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Regular Expression Matching\n\nImplement a TypeScript function:\nfunction isMatch(s: string, p: string): boolean\n\nExample 1:\nInput: s = \"aa\", p = \"a\"\nOutput: false",
    "targetLanguage": "typescript",
    "maxAttempts": 4
  }'
```

### `POST /parse/problem`

Parse raw question text into a structured blueprint JSON without solving it.

```bash
curl -X POST http://localhost:3000/parse/problem \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Regular Expression Matching\n\nImplement a TypeScript function:\nfunction isMatch(s: string, p: string): boolean"
  }'
```

### `POST /telegram/webhook`

Receives Telegram updates. Register this URL as your bot webhook (see setup above).

## Project structure

```
src/
  agents/          # Code generation and testing agent implementations
  contracts/       # Zod schemas and TypeScript types
  services/
    execution/     # Code execution / verifier runners
    llm/           # OpenAI chat model wrappers
    parsing/       # Problem blueprint parser
    solvers/       # High-level solve orchestration
    storage/       # Solve artifact store (Upstash Redis)
    streaming/     # SSE helpers
    telegram/      # Telegram webhook, session store, bot client
    vision/        # Image OCR / problem extraction
  utils/           # Logger
api/               # Vercel serverless entry point
tests/             # Test suite
```

## Agents

| Agent | Description |
|---|---|
| `SupervisorAgent` | Orchestrates the generate → test → retry loop |
| `GeminiCodeGenerationAgent` | Generates solutions via Google Gemini |
| `DeepAgentCodeGenerationAgent` | Generates solutions via OpenAI / DeepAgents |
| `MultiCodeGenerationAgent` | Runs multiple generation agents in parallel and picks the best candidate |
| `DeepAgentCodeTestingAgent` | Tests candidates and produces structured feedback |
