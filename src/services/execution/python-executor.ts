import { ProcessCodeExecutor } from "./code-executor.ts";

export class PythonExecutor extends ProcessCodeExecutor {
  readonly language = "python";

  protected getCommand(filePath: string) {
    return {
      command: "python3",
      args: [],
      extension: ".py",
    };
  }
}
