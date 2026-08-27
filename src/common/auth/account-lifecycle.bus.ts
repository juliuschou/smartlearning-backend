import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process account lifecycle signal bus (US-F8).
 *
 * A separate boundary from `LiveSessionEventBus` (which is scoped to a live
 * session room): account-level events (e.g. `account.disabled`) have no single
 * liveSessionId, so they must not be mixed into the live-session domain. The
 * bus is a leaf with no service deps, so both `AccountService` (identity) and
 * `LiveGateway` (realtime) inject the same singleton via the global AuthModule
 * without importing each other's modules — one-way dependency, no cycle.
 *
 * Semantics mirror the realtime bus: publish is post-commit and fire-and-forget
 * from the caller's perspective; a listener error is isolated and logged so it
 * can never fail an already-committed DB mutation. In-process ⇒ **single
 * instance** guarantee only; cross-instance revocation (Redis/outbox/replay)
 * is deferred.
 */
export type AccountLifecycleSignal = {
  type: 'account.disabled';
  accountId: string;
  timestamp: string;
};

export type AccountLifecycleListener = (
  signal: AccountLifecycleSignal,
) => void | Promise<void>;

@Injectable()
export class AccountLifecycleBus {
  private readonly logger = new Logger(AccountLifecycleBus.name);
  private readonly listeners = new Set<AccountLifecycleListener>();

  /** Fan a signal out to every subscriber. See class doc for error isolation. */
  async publish(signal: AccountLifecycleSignal): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(signal);
      } catch (error) {
        this.logger.error(
          {
            signalType: signal.type,
            accountId: signal.accountId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Account lifecycle listener threw; continuing remaining listeners',
        );
      }
    }
  }

  /** Register a listener and return an unsubscribe handle. */
  subscribe(listener: AccountLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
