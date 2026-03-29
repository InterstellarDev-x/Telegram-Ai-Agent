import type { AgentEnvelope, AgentRole } from "../contracts/agents.ts";
import type { Logger } from "../utils/logger.ts";

export class InMemoryAgentTransport {
  private readonly transcript: AgentEnvelope[] = [];

  constructor(private readonly logger: Logger) {}

  send<TPayload>(
    from: AgentRole,
    to: AgentRole,
    type: string,
    payload: TPayload,
    correlationId: string,
  ): AgentEnvelope<TPayload> {
    const envelope: AgentEnvelope<TPayload> = {
      id: crypto.randomUUID(),
      correlationId,
      timestamp: new Date().toISOString(),
      from,
      to,
      type,
      payload,
    };

    this.transcript.push(envelope);
    this.logger.info("agent-message", {
      from,
      to,
      type,
      correlationId,
    });

    return envelope;
  }

  list(correlationId?: string): AgentEnvelope[] {
    if (!correlationId) {
      return [...this.transcript];
    }

    return this.transcript.filter(
      (envelope) => envelope.correlationId === correlationId,
    );
  }
}
