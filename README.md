# hackwithinfy

Scalable Bun + TypeScript backend for a Telegram-style coding solver workflow.

It includes:

- A `SupervisorAgent` that orchestrates retries
- A DeepAgent-backed `CodeGenerationAgent`
- A DeepAgent-backed `CodeTestingAgent`
- Executable verifiers for `javascript`, `typescript`, and `python`
- A local scripted demo that proves the correction loop without calling OpenAI

## Install

```bash
bun install
```

## Run the example flow

```bash
bun run demo
```

The demo intentionally generates one incorrect solution first, fails hidden verifier tests, retries, and then returns the verified code.

## Run tests

```bash
bun test
```

## Run streaming API

```bash
bun run serve
```

## Telegram Bot

Set these environment variables before starting the server:

```bash
export OPENAI_API_KEY="your-key"
export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
export TELEGRAM_WEBHOOK_SECRET="optional-shared-secret"
export OPENAI_MODEL="gpt-4.1"
export OPENAI_VISION_MODEL="gpt-4.1"
```

Then expose your local server and point Telegram at:

```text
POST /telegram/webhook
```

The webhook accepts Telegram updates, downloads the largest uploaded photo, extracts the coding question from the image with OpenAI vision, converts it into the existing deterministic problem JSON, runs the supervisor generator/tester loop, and replies in the same chat with the verified code.

Telegram chat flow:

- Send `1` to start collecting images.
- Send one or more screenshots/photos of the coding problem.
- Send `2` to stop collecting and start OCR + solving.
- If the images are blurry or cropped, the bot asks for clearer images and stays in collection mode.

POST to `/solve/stream` with `Content-Type: application/json`. The response is Server-Sent Events and streams logs plus the final result.

Example:

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

You can also send only the raw question text and let the parser agent build the structured JSON first:

```bash
curl -N -X POST http://localhost:3000/solve/from-text/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Regular Expression Matching\n\nImplement a TypeScript function:\nfunction isMatch(s: string, p: string): boolean\n\nExample 1:\nInput: s = \"aa\", p = \"a\"\nOutput: false\n\nExample 2:\nInput: s = \"aa\", p = \"a*\"\nOutput: true\n\nExample 3:\nInput: s = \"ab\", p = \".*\"\nOutput: true",
    "targetLanguage": "typescript",
    "maxAttempts": 4
  }'
```

If you only want the deterministic JSON blueprint without solving, call:

```bash
curl -X POST http://localhost:3000/parse/problem \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Regular Expression Matching\n\nImplement a TypeScript function:\nfunction isMatch(s: string, p: string): boolean\n\nExample 1:\nInput: s = \"aa\", p = \"a\"\nOutput: false"
  }'
```

## Use real OpenAI-backed agents

Set:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-4.1"
```

Then instantiate `DeepAgentCodeGenerationAgent` and `DeepAgentCodeTestingAgent` with a model from [`src/services/llm/openai-chat-model.ts`](./src/services/llm/openai-chat-model.ts).
