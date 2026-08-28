import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process post-commit wake bus.
 *
 * Domain mutation services publish a thin compatibility signal here after the
 * PostgreSQL transaction commits. The durable publisher uses it only to wake a
 * bounded outbox scan; startup scanning remains the recovery mechanism. The
 * bus carries no authoritative event sequence or projection data, and listener
 * failures are isolated so they cannot alter a committed mutation.
 */

export type LiveSessionSignal =
  | { type: 'participant.joined'; liveSessionId: string; participantId: string }
  | {
      type: 'question.opened';
      liveSessionId: string;
      sessionQuestionId: string;
    }
  | {
      type: 'question.closed';
      liveSessionId: string;
      sessionQuestionId: string;
    }
  | {
      type: 'session.state_changed';
      liveSessionId: string;
      status: string;
    }
  | {
      type: 'submission.committed';
      liveSessionId: string;
      sessionQuestionId: string;
      participantId: string;
    };

export type LiveSessionSignalListener = (
  signal: LiveSessionSignal,
) => void | Promise<void>;

@Injectable()
export class LiveSessionEventBus {
  private readonly logger = new Logger(LiveSessionEventBus.name);
  private readonly listeners = new Set<LiveSessionSignalListener>();

  /**
   * Fan a signal out to every subscriber. Synchronous and fire-and-forget from
   * the caller's perspective: any listener error is caught, logged, and
   * isolated so it cannot break the publishing mutation or starve other
   * listeners. The returned promise resolves once all (synchronous) listener
   * invocations have been attempted; a rejected listener does NOT reject this
   * promise.
   */
  async publish(signal: LiveSessionSignal): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(signal);
      } catch (error) {
        this.logger.error(
          {
            signalType: signal.type,
            liveSessionId: signal.liveSessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Realtime signal listener threw; continuing remaining listeners',
        );
      }
    }
  }

  /** Register a listener and return an unsubscribe handle. */
  subscribe(listener: LiveSessionSignalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
