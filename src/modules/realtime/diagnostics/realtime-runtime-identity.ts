import os from 'node:os';
import { newId } from '../../../common/crypto';

export interface RealtimeRuntimeIdentity {
  backendInstanceId: string;
  processId: number;
  processStartIso: string;
  hostname: string;
}

/** Immutable identity shared by all realtime providers in this Node process. */
export const realtimeRuntimeIdentity: RealtimeRuntimeIdentity = Object.freeze({
  backendInstanceId: newId(),
  processId: process.pid,
  processStartIso: new Date(
    Date.now() - process.uptime() * 1_000,
  ).toISOString(),
  hostname: os.hostname(),
});
