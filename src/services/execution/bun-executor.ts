import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { ProcessCodeExecutor, runCommand, type ExecutionResult } from "./code-executor.js";

export class BunJavaScriptExecutor extends ProcessCodeExecutor {
  readonly language = "javascript";

  protected getCommand(filePath: string) {
    return {
      command: "bun",
      args: [],
      extension: ".js",
    };
  }
}

export class BunTypeScriptExecutor extends ProcessCodeExecutor {
  readonly language = "typescript";

  protected getCommand(_filePath: string) {
    return {
      command: "node",
      args: [],
      extension: ".js",
    };
  }

  override async execute(
    code: string,
    stdin: string,
    timeoutMs: number,
  ): Promise<ExecutionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "telegram-bot-solver-"));
    const jsFilePath = join(tempDir, "solution.js");

    try {
      const transpiled = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          strict: false,
        },
        reportDiagnostics: false,
      });

      await writeFile(jsFilePath, transpiled.outputText, "utf8");
      return await runCommand("node", [jsFilePath], stdin, timeoutMs);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
