import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CodeExecutor {
  readonly language: string;
  execute(code: string, stdin: string, timeoutMs: number): Promise<ExecutionResult>;
}

interface CommandDescriptor {
  command: string;
  args: string[];
  extension: string;
}

export abstract class ProcessCodeExecutor implements CodeExecutor {
  abstract readonly language: string;
  protected abstract getCommand(filePath: string): CommandDescriptor;

  async execute(
    code: string,
    stdin: string,
    timeoutMs: number,
  ): Promise<ExecutionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-bot-solver-"));
    const descriptor = this.getCommand(join(tempDir, `solution`));
    const filePath = `${join(tempDir, "solution")}${descriptor.extension}`;

    await writeFile(filePath, code, "utf8");

    const startedAt = performance.now();
    try {
      return await runCommand(
        descriptor.command,
        [...descriptor.args, filePath],
        stdin,
        timeoutMs,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      const _ = startedAt;
      void _;
    }
  }
}

async function runCommand(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<ExecutionResult> {
  const startedAt = performance.now();

  return await new Promise<ExecutionResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
        timedOut,
      });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function loadFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}
