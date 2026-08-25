/**
 * Season capacity arithmetic.
 *
 * This runs before anyone is sold anything. The paid-weeks guarantee is a
 * promise about court time, and court time is a fixed quantity — no scheduling
 * cleverness can create more of it. Overselling is therefore caught here, at
 * registration, rather than discovered in week 22.
 */

export interface CapacityInput {
  /** Number of playing weeks in the season. */
  weeks: number;
  /** Courts booked on a league night. */
  courts: number;
  /** Waves per court per night (1 = one start time). */
  slotsPerCourt: number;
  /** Number of teams (couples) on the roster. */
  teams: number;
}

export interface CapacityReport {
  matchesPerWeek: number;
  /** Teams that can be on court in a single week. */
  teamsOnCourtPerWeek: number;
  /** Teams with nothing to do in a given week. */
  teamsIdlePerWeek: number;
  /** Total team-slots available across the whole season. */
  totalTeamSlots: number;
  /** Hard ceiling: no team can be scheduled more weeks than this. */
  maxWeeksPerTeam: number;
  /**
   * What to actually sell: one week of slack per team, so a single blackout
   * date or vacation doesn't make the season infeasible.
   */
  recommendedCap: number;
  /** Fraction of capacity consumed if every team buys `recommendedCap`. */
  utilizationAtRecommendedCap: number;
  /** Team-slots left unsold at `recommendedCap` — the extra-play waitlist pool. */
  slackAtRecommendedCap: number;
}

export function computeCapacity(input: CapacityInput): CapacityReport {
  const { weeks, courts, slotsPerCourt, teams } = input;

  for (const [key, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`capacity: ${key} must be a positive integer, got ${value}`);
    }
  }
  if (teams % 2 !== 0) {
    // Odd rosters are schedulable (one team byes each round) but the capacity
    // story changes, so make the caller opt in deliberately rather than
    // silently handing back numbers that assume everyone plays.
    throw new RangeError(`capacity: teams must be even for fixed-pair play, got ${teams}`);
  }

  const matchesPerWeek = courts * slotsPerCourt;
  const teamsOnCourtPerWeek = Math.min(matchesPerWeek * 2, teams);
  const totalTeamSlots = weeks * teamsOnCourtPerWeek;
  const maxWeeksPerTeam = Math.min(weeks, Math.floor(totalTeamSlots / teams));
  const recommendedCap = Math.max(1, maxWeeksPerTeam - 1);
  const soldSlots = recommendedCap * teams;

  return {
    matchesPerWeek,
    teamsOnCourtPerWeek,
    teamsIdlePerWeek: teams - teamsOnCourtPerWeek,
    totalTeamSlots,
    maxWeeksPerTeam,
    recommendedCap,
    utilizationAtRecommendedCap: soldSlots / totalTeamSlots,
    slackAtRecommendedCap: totalTeamSlots - soldSlots,
  };
}

/**
 * Check a set of purchases against capacity.
 *
 * Returns the teams that cannot be honoured and by how much, so the admin sees
 * names and numbers rather than "infeasible".
 */
export interface EntitlementCheck {
  feasible: boolean;
  totalPurchased: number;
  totalTeamSlots: number;
  /** Teams whose purchase exceeds the per-team ceiling. */
  overCeiling: Array<{ teamId: string; purchased: number; ceiling: number; excess: number }>;
  /** Team-slots oversold in aggregate, even if no single team is over the ceiling. */
  aggregateExcess: number;
}

export function checkEntitlements(
  input: CapacityInput,
  purchases: Record<string, number>,
): EntitlementCheck {
  const cap = computeCapacity(input);
  const entries = Object.entries(purchases);

  const overCeiling = entries
    .filter(([, purchased]) => purchased > cap.maxWeeksPerTeam)
    .map(([teamId, purchased]) => ({
      teamId,
      purchased,
      ceiling: cap.maxWeeksPerTeam,
      excess: purchased - cap.maxWeeksPerTeam,
    }));

  const totalPurchased = entries.reduce((sum, [, n]) => sum + n, 0);
  const aggregateExcess = Math.max(0, totalPurchased - cap.totalTeamSlots);

  return {
    feasible: overCeiling.length === 0 && aggregateExcess === 0,
    totalPurchased,
    totalTeamSlots: cap.totalTeamSlots,
    overCeiling,
    aggregateExcess,
  };
}

/** Plain-English capacity summary for the admin console. */
export function explainCapacity(input: CapacityInput): string[] {
  const c = computeCapacity(input);
  const lines = [
    `${input.weeks} weeks x ${input.courts} courts x ${input.slotsPerCourt} wave(s) = ` +
      `${c.matchesPerWeek} matches per week.`,
    `${c.teamsOnCourtPerWeek} of ${input.teams} couples are on court each week` +
      (c.teamsIdlePerWeek > 0 ? `; ${c.teamsIdlePerWeek} sit out.` : `.`),
    `Season capacity is ${c.totalTeamSlots} team-slots, so no couple can be ` +
      `scheduled more than ${c.maxWeeksPerTeam} weeks.`,
  ];

  if (c.recommendedCap < c.maxWeeksPerTeam) {
    lines.push(
      `Selling ${c.maxWeeksPerTeam} to everyone would consume 100% of capacity, ` +
        `leaving no room for blackout dates. Recommended cap is ` +
        `${c.recommendedCap} weeks (${Math.round(c.utilizationAtRecommendedCap * 100)}% ` +
        `utilisation, ${c.slackAtRecommendedCap} slots of slack).`,
    );
  }
  if (c.teamsIdlePerWeek > 0) {
    lines.push(
      `Adding a second wave would take capacity to ` +
        `${input.weeks * Math.min(input.courts * (input.slotsPerCourt + 1) * 2, input.teams)} ` +
        `team-slots and put every couple on court every week.`,
    );
  }
  return lines;
}
