import {
  canCloseLiveSession,
  canStartLiveSession,
  LiveSessionStatus,
} from './live-session-status';
import {
  canCloseSessionQuestion,
  canOpenSessionQuestion,
  SessionQuestionStatus,
} from './session-question-status';
import {
  generateSessionCode,
  isSessionCode,
  normalizeSessionCode,
} from './session-code';

describe('live-session state contract', () => {
  it('allows only waiting → active and active → closed', () => {
    expect(canStartLiveSession(LiveSessionStatus.WAITING)).toBe(true);
    expect(canStartLiveSession(LiveSessionStatus.ACTIVE)).toBe(false);
    expect(canCloseLiveSession(LiveSessionStatus.ACTIVE)).toBe(true);
    expect(canCloseLiveSession(LiveSessionStatus.CLOSED)).toBe(false);
  });

  it('allows only not_open → open → closed for session questions', () => {
    expect(canOpenSessionQuestion(SessionQuestionStatus.NOT_OPEN)).toBe(true);
    expect(canOpenSessionQuestion(SessionQuestionStatus.OPEN)).toBe(false);
    expect(canCloseSessionQuestion(SessionQuestionStatus.OPEN)).toBe(true);
    expect(canCloseSessionQuestion(SessionQuestionStatus.CLOSED)).toBe(false);
  });

  it('generates and canonicalizes non-confusable codes', () => {
    const code = generateSessionCode();
    expect(code).toHaveLength(8);
    expect(isSessionCode(code)).toBe(true);
    expect(isSessionCode(code.toLowerCase())).toBe(true);
    expect(isSessionCode('IO01ABCD')).toBe(false);
    expect(normalizeSessionCode(` ${code.toLowerCase()} `)).toBe(code);
  });
});
