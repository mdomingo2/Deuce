import type { Schedule, SeasonShape, Team, TeamId } from './types.js';

export type ViolationCode =
  | 'team-double-booked'
  | 'court-double-booked'
  | 'self-match'
  | 'unknown-team'
  | 'unknown-week'
  | 'unknown-court'
  | 'entitlement-deficit';

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface ValidateOptions {
  /** Weeks each team purchased. Omit to skip the guarantee check. */
  entitlements?: Record<TeamId, number>;
}

/**
 * Check a schedule against every hard constraint.
 *
 * This is what stands behind the publish gate: a schedule with any violation is
 * never published, and a deficit is reported by name so the admin sees which
 * couple is short and by how much rather than the word "infeasible".
 */
export function validateSchedule(
  teams: readonly Team[],
  season: SeasonShape,
  schedule: Schedule,
  options: ValidateOptions = {},
): Violation[] {
  const violations: Violation[] = [];
  const knownTeams = new Set(teams.map((t) => t.id));
  const knownWeeks = new Set(season.weeks);
  const knownCourts = new Set(season.courts);

  const playedThisWeek = new Map<string, Set<TeamId>>();
  const occupiedSlots = new Set<string>();

  for (const match of schedule.matches) {
    const { weekId, courtId, slotIndex, homeTeamId, awayTeamId } = match;

    if (!knownWeeks.has(weekId)) {
      violations.push({ code: 'unknown-week', message: `Match scheduled in unknown week ${weekId}.` });
    }
    if (!knownCourts.has(courtId)) {
      violations.push({ code: 'unknown-court', message: `Match scheduled on unknown court ${courtId}.` });
    }
    for (const id of [homeTeamId, awayTeamId]) {
      if (!knownTeams.has(id)) {
        violations.push({ code: 'unknown-team', message: `Match references unknown team ${id}.` });
      }
    }
    if (homeTeamId === awayTeamId) {
      violations.push({
        code: 'self-match',
        message: `Team ${homeTeamId} is scheduled against itself in week ${weekId}.`,
      });
    }

    const slotKey = `${weekId}|${courtId}|${slotIndex}`;
    if (occupiedSlots.has(slotKey)) {
      violations.push({
        code: 'court-double-booked',
        message: `Court ${courtId} slot ${slotIndex} has more than one match in week ${weekId}.`,
      });
    }
    occupiedSlots.add(slotKey);

    let seen = playedThisWeek.get(weekId);
    if (!seen) {
      seen = new Set();
      playedThisWeek.set(weekId, seen);
    }
    for (const id of [homeTeamId, awayTeamId]) {
      if (seen.has(id)) {
        violations.push({
          code: 'team-double-booked',
          message: `Team ${id} is scheduled twice in week ${weekId}.`,
        });
      }
      seen.add(id);
    }
  }

  if (options.entitlements) {
    for (const [teamId, purchased] of Object.entries(options.entitlements)) {
      const scheduled = schedule.weeksByTeam[teamId]?.length ?? 0;
      if (scheduled < purchased) {
        violations.push({
          code: 'entitlement-deficit',
          message:
            `Team ${teamId} purchased ${purchased} weeks but is scheduled for ` +
            `${scheduled}. Short by ${purchased - scheduled}.`,
        });
      }
    }
  }

  return violations;
}
