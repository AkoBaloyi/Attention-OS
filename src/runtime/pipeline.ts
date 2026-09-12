/**
 * The pipeline: canonical message in, routed decision out.
 *
 * This is what the adapters call, and it is the only thing they are allowed to
 * call. It exists so the sequence a judge sees on the dashboard is the actual
 * sequence in the code:
 *
 *   MESSAGE -> PERCEPTION -> COST -> BUDGET -> ROUTE
 *
 * Focus state is read through a getter rather than captured at construction, so
 * flipping the toggle affects the very next message without restarting anything.
 */

import type { CanonicalMessage } from '../contracts/message.ts';
import type { Decision } from '../contracts/decision.ts';
import type { Clock } from '../contracts/context.ts';
import type { Perceiver } from '../perception/perceiver.ts';
import type { Ledger } from '../store/ledger.ts';
import type { PolicyOptions } from '../policy/engine.ts';
import { evaluateMessage } from './evaluate.ts';

export type PipelineEvent =
  | { kind: 'decision'; message: CanonicalMessage; decision: Decision }
  | { kind: 'error'; messageId: string; stage: 'perception' | 'policy'; error: string }
  | { kind: 'focus'; focusActive: boolean };

export type Pipeline = {
  ingest(message: CanonicalMessage): Promise<Decision | null>;
  subscribe(listener: (event: PipelineEvent) => void): () => void;
  emit(event: PipelineEvent): void;
};

export function createPipeline(deps: {
  perceiver: Perceiver;
  ledger: Ledger;
  clock?: Clock;
  /** Read per-message, not captured, so the toggle takes effect immediately. */
  getFocusActive: () => boolean;
  /** Same reasoning: rolling the window must affect the very next message. */
  getWindowAnchor?: () => string | undefined;
  getPolicyOptions?: () => PolicyOptions;
  onError?: (error: unknown) => void;
}): Pipeline {
  const listeners = new Set<(event: PipelineEvent) => void>();

  function emit(event: PipelineEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken dashboard subscriber must never take down ingestion.
      }
    }
  }

  return {
    async ingest(message: CanonicalMessage): Promise<Decision | null> {
      let envelope;
      try {
        envelope = await deps.perceiver.perceive(message);
      } catch (error) {
        // Perception failing is not a reason to interrupt, and it is not a
        // reason to silently drop a message either. Surface it and move on.
        deps.onError?.(error);
        emit({
          kind: 'error',
          messageId: message.id,
          stage: 'perception',
          error: String(error),
        });
        return null;
      }

      try {
        const decision = evaluateMessage(
          {
            ledger: deps.ledger,
            clock: deps.clock,
            focusActive: deps.getFocusActive(),
            windowAnchor: deps.getWindowAnchor?.(),
            policy: deps.getPolicyOptions?.(),
          },
          message,
          envelope,
        );

        emit({ kind: 'decision', message, decision });
        return decision;
      } catch (error) {
        deps.onError?.(error);
        emit({
          kind: 'error',
          messageId: message.id,
          stage: 'policy',
          error: String(error),
        });
        return null;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    emit,
  };
}
