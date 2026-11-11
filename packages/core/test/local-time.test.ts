import { afterEach, describe, expect, it } from 'vitest';
import { localTime } from '../src/index.js';

const AT = '2026-11-09T07:26:05.000Z';

describe('localTime (AO-0174)', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('prints local wall time with the UTC offset', () => {
    process.env.TZ = 'Asia/Bangkok';
    expect(localTime(AT)).toBe('2026-11-09 14:26+07:00');
    expect(localTime(Date.parse(AT), { seconds: true })).toBe('2026-11-09 14:26:05+07:00');
    process.env.TZ = 'America/New_York';
    expect(localTime(AT)).toBe('2026-11-09 02:26-05:00');
    process.env.TZ = 'Asia/Kolkata';
    expect(localTime(AT)).toBe('2026-11-09 12:56+05:30');
    process.env.TZ = 'UTC';
    expect(localTime(AT)).toBe('2026-11-09 07:26+00:00');
  });

  it('names the same instant in any zone', () => {
    const out = localTime(AT, { seconds: true });
    expect(Date.parse(out.replace(' ', 'T'))).toBe(Date.parse(AT));
  });

  it('passes an unparsable value through', () => {
    expect(localTime('not a time')).toBe('not a time');
  });
});
