import { ProcessCodeExecutor } from "./code-executor.ts";

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

  protected getCommand(filePath: string) {
    return {
      command: "bun",
      args: [],
      extension: ".ts",
    };
  }
}
