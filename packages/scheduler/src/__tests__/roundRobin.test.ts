import { describe, expect, it } from 'vitest';
import { buildRoundRobinSchedule } from '../roundRobin.js';
import { validateSchedule } from '../validate.js';
import type { SeasonShape, Team } from '../types.js';

const COUPLES: Team[] = [
  'Domingo', 'Hoffman', 'Reyes', 'Whitaker',
  'Nakamura', 'Okafor', 'Bergstrom', 'Silva',
].map((name, i) => ({ id: `t${i}`, name }));

const season = (weeks: number, courts = 2, slotsPerCourt = 1): SeasonShape => ({
  weeks: Array.from({ length: weeks }, (_, i) => `w${i + 1}`),
  courts: Array.from({ length: courts }, (_, i) => `court-${i + 1}`),
  slotsPerCourt,
});

/** Count how many times each unordered pair of teams meets. */
function meetingCounts(teams: Team[], matches: { homeTeamId: string; awayTeamId: string }[]) {
  const counts = new Map<string, number>();
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      counts.set(`${teams[i]!.id} ${teams[j]!.id}`, 0);
    }
  }
  for (const m of matches) {
    const [a, b] = [m.homeTeamId, m.awayTeamId].sort();
    const key = `${a} ${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('buildRoundRobinSchedule', () => {
  it('produces a PERFECT double round-robin at 28 weeks on 2 courts', () => {
    // The marquee property: 8 couples, 2 courts, 28 weeks means every couple
    // meets every other couple exactly twice. This is why 26 playing weeks
    // inside a 28-week calendar is the recommended shape.
    const s = season(28);
    const schedule = buildRoundRobinSchedule(COUPLES, s);

    expect(schedule.matches).toHaveLength(56);
    expect(schedule.meta.rounds).toBe(14);
    expect(schedule.meta.isPerfectDoubleRoundRobin).toBe(true);

    const counts = meetingCounts(COUPLES, schedule.matches);
    expect(counts.size).toBe(28);
    for (const [pair, n] of counts) {
      expect(n, `pair ${pair} should meet exactly twice`).toBe(2);
    }
    for (const team of COUPLES) {
      expect(schedule.weeksByTeam[team.id]).toHaveLength(14);
    }
  });

  it('lands one round short of a double round-robin at 26 weeks', () => {
    const schedule = buildRoundRobinSchedule(COUPLES, season(26));

    expect(schedule.matches).toHaveLength(52);
    expect(schedule.meta.rounds).toBe(13);
    expect(schedule.meta.isPerfectDoubleRoundRobin).toBe(false);
    expect(schedule.meta.meetingsPerPair).toEqual({ min: 1, max: 2 });

    // Every couple still plays exactly 13 times: the ceiling from the capacity math.
    for (const team of COUPLES) {
      expect(schedule.weeksByTeam[team.id]).toHaveLength(13);
    }
    // Exactly four pairings are the ones that only meet once.
    const single = [...meetingCounts(COUPLES, schedule.matches).values()].filter((n) => n === 1);
    expect(single).toHaveLength(4);
  });

  it('violates no hard constraint and satisfies a 12-week entitlement', () => {
    const s = season(26);
    const schedule = buildRoundRobinSchedule(COUPLES, s);
    const entitlements = Object.fromEntries(COUPLES.map((t) => [t.id, 12]));

    expect(validateSchedule(COUPLES, s, schedule, { entitlements })).toEqual([]);
  });

  it('reports a deficit when a couple bought more than capacity allows', () => {
    const s = season(26);
    const schedule = buildRoundRobinSchedule(COUPLES, s);
    const entitlements = { ...Object.fromEntries(COUPLES.map((t) => [t.id, 12])), t2: 15 };

    const violations = validateSchedule(COUPLES, s, schedule, { entitlements });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.code).toBe('entitlement-deficit');
    expect(violations[0]!.message).toContain('Short by 2');
  });

  it('spreads couples across courts instead of parking them on court 1', () => {
    const schedule = buildRoundRobinSchedule(COUPLES, season(26));
    for (const team of COUPLES) {
      const courts = new Set(
        schedule.matches
          .filter((m) => m.homeTeamId === team.id || m.awayTeamId === team.id)
          .map((m) => m.courtId),
      );
      expect(courts.size, `${team.name} should see both courts`).toBe(2);
    }
  });

  it('puts every couple on court every week when a second wave is added', () => {
    const s = season(26, 2, 2);
    const schedule = buildRoundRobinSchedule(COUPLES, s);

    expect(schedule.meta.matchesPerWeek).toBe(4);
    for (const team of COUPLES) {
      expect(schedule.weeksByTeam[team.id]).toHaveLength(26);
    }
    expect(validateSchedule(COUPLES, s, schedule)).toEqual([]);
  });

  it('is deterministic', () => {
    const a = buildRoundRobinSchedule(COUPLES, season(26));
    const b = buildRoundRobinSchedule(COUPLES, season(26));
    expect(a).toEqual(b);
  });

  it('handles an odd roster by giving one team a bye each round', () => {
    const odd = COUPLES.slice(0, 7);
    const s = season(14, 2, 1);
    const schedule = buildRoundRobinSchedule(odd, s);

    expect(validateSchedule(odd, s, schedule)).toEqual([]);
    // With 7 teams, 3 matches per round means a round spans 1.5 weeks, so team
    // totals differ; what must hold is that nobody is double-booked.
    for (const team of odd) {
      expect(schedule.weeksByTeam[team.id]!.length).toBeGreaterThan(0);
    }
  });

  it('refuses a roster too small for the courts booked', () => {
    expect(() => buildRoundRobinSchedule(COUPLES.slice(0, 2), season(10, 2, 1))).toThrow(
      /needs 4 teams/,
    );
  });

  it('rejects duplicate team ids', () => {
    const dupes = [...COUPLES, { id: 't0', name: 'Domingo again' }];
    expect(() => buildRoundRobinSchedule(dupes, season(26))).toThrow(/unique/);
  });
});
