import type { SupportedLanguage } from "../../contracts/problem.js";
import type { CodeExecutor } from "./code-executor.js";

export class ExecutorRegistry {
  private readonly executors = new Map<SupportedLanguage, CodeExecutor>();

  constructor(executors: CodeExecutor[]) {
    for (const executor of executors) {
      this.executors.set(executor.language as SupportedLanguage, executor);
    }
  }

  get(language: SupportedLanguage): CodeExecutor {
    const executor = this.executors.get(language);

    if (!executor) {
      throw new Error(`No executor configured for language: ${language}`);
    }

    return executor;
  }
}
