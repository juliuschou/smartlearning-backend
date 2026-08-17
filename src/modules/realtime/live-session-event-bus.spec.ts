import { LiveSessionEventBus } from './live-session-event-bus';

describe('LiveSessionEventBus', () => {
  let bus: LiveSessionEventBus;

  beforeEach(() => {
    bus = new LiveSessionEventBus();
  });

  it('fans a signal out to every subscriber', async () => {
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((s) => {
      a.push(s.type);
    });
    bus.subscribe((s) => {
      b.push(s.type);
    });

    await bus.publish({
      type: 'question.opened',
      liveSessionId: 's1',
      sessionQuestionId: 'q1',
    });

    expect(a).toEqual(['question.opened']);
    expect(b).toEqual(['question.opened']);
  });

  it('a throwing listener does not break the publish or other listeners', async () => {
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((s) => {
      seen.push(s.type);
    });

    // Must not reject — the publishing mutation must survive a listener failure.
    await bus.publish({
      type: 'submission.committed',
      liveSessionId: 's1',
      sessionQuestionId: 'q1',
      participantId: 'p1',
    });

    expect(seen).toEqual(['submission.committed']);
  });

  it('a rejecting async listener is isolated from other listeners', async () => {
    const seen: string[] = [];
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.subscribe((s) => {
      seen.push(s.type);
    });

    await bus.publish({
      type: 'participant.joined',
      liveSessionId: 's1',
      participantId: 'p1',
    });

    expect(seen).toEqual(['participant.joined']);
  });

  it('unsubscribe stops further delivery to that listener', async () => {
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((s) => {
      seen.push(s.type);
    });

    await bus.publish({
      type: 'session.state_changed',
      liveSessionId: 's1',
      status: 'active',
    });
    unsubscribe();
    await bus.publish({
      type: 'session.state_changed',
      liveSessionId: 's1',
      status: 'closed',
    });

    expect(seen).toEqual(['session.state_changed']);
  });

  it('delivers all signal variants', async () => {
    const seen: string[] = [];
    bus.subscribe((s) => {
      seen.push(s.type);
    });

    await bus.publish({
      type: 'question.opened',
      liveSessionId: 's1',
      sessionQuestionId: 'q1',
    });
    await bus.publish({
      type: 'question.closed',
      liveSessionId: 's1',
      sessionQuestionId: 'q1',
    });

    expect(seen).toEqual(['question.opened', 'question.closed']);
  });
});
