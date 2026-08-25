import { describe, expect, it } from 'vitest';
import { checkEntitlements, computeCapacity, explainCapacity } from '../capacity.js';

/** The real league: 8 couples, 2 courts, one wave, 26 playing weeks. */
const LEAGUE = { weeks: 26, courts: 2, slotsPerCourt: 1, teams: 8 } as const;

describe('computeCapacity', () => {
  it('derives the real leagues ceiling of 13 weeks per couple', () => {
    const c = computeCapacity(LEAGUE);
    expect(c.matchesPerWeek).toBe(2);
    expect(c.teamsOnCourtPerWeek).toBe(4);
    expect(c.teamsIdlePerWeek).toBe(4);
    expect(c.totalTeamSlots).toBe(104);
    expect(c.maxWeeksPerTeam).toBe(13);
  });

  it('recommends 12, leaving 8 slots of slack', () => {
    const c = computeCapacity(LEAGUE);
    expect(c.recommendedCap).toBe(12);
    expect(c.slackAtRecommendedCap).toBe(8);
    expect(c.utilizationAtRecommendedCap).toBeCloseTo(96 / 104, 5);
  });

  it('doubles capacity and removes idle couples with a second wave', () => {
    const c = computeCapacity({ ...LEAGUE, slotsPerCourt: 2 });
    expect(c.matchesPerWeek).toBe(4);
    expect(c.teamsOnCourtPerWeek).toBe(8);
    expect(c.teamsIdlePerWeek).toBe(0);
    expect(c.totalTeamSlots).toBe(208);
    expect(c.maxWeeksPerTeam).toBe(26);
  });

  it('never lets the ceiling exceed the number of playing weeks', () => {
    // Three courts for four teams still means a team plays at most once a week.
    const c = computeCapacity({ weeks: 10, courts: 3, slotsPerCourt: 1, teams: 4 });
    expect(c.teamsOnCourtPerWeek).toBe(4);
    expect(c.maxWeeksPerTeam).toBe(10);
  });

  it('rejects odd rosters and non-positive inputs', () => {
    expect(() => computeCapacity({ ...LEAGUE, teams: 7 })).toThrow(/must be even/);
    expect(() => computeCapacity({ ...LEAGUE, courts: 0 })).toThrow(/positive integer/);
    expect(() => computeCapacity({ ...LEAGUE, weeks: 1.5 })).toThrow(/positive integer/);
  });
});

describe('checkEntitlements', () => {
  const evenly = (n: number) =>
    Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, n]));

  it('passes at the recommended cap', () => {
    const result = checkEntitlements(LEAGUE, evenly(12));
    expect(result.feasible).toBe(true);
    expect(result.totalPurchased).toBe(96);
    expect(result.aggregateExcess).toBe(0);
  });

  it('passes at the hard ceiling, with zero room to spare', () => {
    const result = checkEntitlements(LEAGUE, evenly(13));
    expect(result.feasible).toBe(true);
    expect(result.totalPurchased).toBe(result.totalTeamSlots);
  });

  it('names the couples who bought more than the season can deliver', () => {
    const result = checkEntitlements(LEAGUE, { ...evenly(12), t3: 15, t5: 20 });
    expect(result.feasible).toBe(false);
    expect(result.overCeiling).toEqual([
      { teamId: 't3', purchased: 15, ceiling: 13, excess: 2 },
      { teamId: 't5', purchased: 20, ceiling: 13, excess: 7 },
    ]);
  });

  it('drops the ceiling when the season loses a week', () => {
    // 25 weeks is 100 team-slots, so the ceiling falls from 13 to 12 and the
    // couples who bought 13 are now oversold. This is the rainout-that-cannot-
    // be-made-up case, and it must surface by name.
    const result = checkEntitlements({ ...LEAGUE, weeks: 25 }, evenly(13));
    expect(result.feasible).toBe(false);
    expect(result.overCeiling).toHaveLength(8);
    expect(result.overCeiling[0]).toEqual({
      teamId: 't0',
      purchased: 13,
      ceiling: 12,
      excess: 1,
    });
  });

  it('cannot report aggregate oversell while every couple is under the ceiling', () => {
    // The per-team ceiling is floor(totalTeamSlots / teams), so a roster that
    // respects it can never exceed capacity in total. aggregateExcess is kept
    // as a defensive check, not because this case is currently reachable.
    const result = checkEntitlements(LEAGUE, evenly(13));
    expect(result.overCeiling).toEqual([]);
    expect(result.aggregateExcess).toBe(0);
  });
});

describe('explainCapacity', () => {
  it('states the ceiling, the sit-out count, and the second-wave upside', () => {
    const lines = explainCapacity(LEAGUE).join('\n');
    expect(lines).toContain('4 of 8 couples');
    expect(lines).toContain('sit out');
    expect(lines).toContain('more than 13 weeks');
    expect(lines).toContain('second wave');
  });
});
