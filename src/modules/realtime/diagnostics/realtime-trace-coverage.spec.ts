import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Emit-site coverage guard.
 *
 * The W3 diagnostic is only trustworthy if EVERY durable fan-out emit is traced.
 * A future emit added to the gateway without a trace (or without an explicit
 * `trace-exempt` marker) would silently reintroduce the exact evidence gap this
 * diagnostic exists to close — so this test fails instead.
 *
 * `emitTraced` itself contains one `socket.emit(...)` call (the traced path);
 * every other raw `.emit(` must carry a `trace-exempt:` comment on the
 * immediately preceding line.
 */
describe('LiveGateway emit-site trace coverage', () => {
  const source = readFileSync(join(__dirname, '..', 'live-gateway.ts'), 'utf8');
  const lines = source.split('\n');

  /** Raw `.emit(` occurrences, excluding the docstring mention. */
  const emitLines = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) => line.includes('.emit(') && !line.includes('`socket.emit('),
    );

  it('accounts for every raw emit site as traced or explicitly exempt', () => {
    const unaccounted = emitLines.filter(({ index }) => {
      if (index >= 1 && lines[index - 1]?.includes('trace-exempt'))
        return false;
      // The single emit inside `emitTraced` is the traced path itself.
      return !lines[index]?.includes('(socket as unknown as Socket).emit(');
    });
    expect(
      unaccounted.map(({ line, index }) => `${index + 1}: ${line.trim()}`),
    ).toEqual([]);
  });

  it('traces every durable fan-out primitive', () => {
    // One emitTraced call per durable recipient emit: shared events, session
    // closed, result-to-socket (teacher + participant branches), teacher counts,
    // teacher results.
    expect(source.match(/this\.emitTraced\(/g)?.length).toBe(6);
  });

  it('records room membership for every durable fan-out primitive', () => {
    // Durable fan-out call sites that enumerate a room and record its
    // membership: emitTeacherSnapshot, emitSharedEvent, emitSessionClosed,
    // emitTeacherResults, emitParticipantResults, plus the teacher
    // count-notification fan-out inside emitTeacherCounts.
    const traceRoomCalls = source.match(/this\.traceRoom\(/g)?.length ?? 0;
    expect(traceRoomCalls).toBe(6);
  });

  it('marks the diagnostic dependency optional', () => {
    expect(source).toMatch(/@Optional\(\)\s+private readonly trace\?/);
  });
});
