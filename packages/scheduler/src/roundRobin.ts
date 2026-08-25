import type { CourtId, Match, Schedule, SeasonShape, Team, TeamId, WeekId } from './types.js';

type Slot = TeamId | null;
type Pairing = readonly [TeamId, TeamId];
type Position = { courtId: CourtId; slotIndex: number };

/**
 * One full rotation of the circle method: `n - 1` rounds in which every team
 * plays exactly once per round.
 *
 * An odd roster gets a `null` slot, and the pairing that would have faced it is
 * dropped, so that team byes for the round.
 */
function baseRounds(teamIds: readonly TeamId[]): Pairing[][] {
  const slots: Slot[] = [...teamIds];
  if (slots.length % 2 === 1) slots.push(null);

  const n = slots.length;
  const fixed = slots[0]!;
  let rot = slots.slice(1);
  const rounds: Pairing[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs: Pairing[] = [];

    // The fixed team alternates home and away as the circle turns.
    const opponent = rot[0]!;
    if (fixed !== null && opponent !== null) {
      pairs.push(r % 2 === 0 ? [fixed, opponent] : [opponent, fixed]);
    }

    for (let i = 1; i < n / 2; i++) {
      const a = rot[i]!;
      const b = rot[n - 1 - i]!;
      if (a !== null && b !== null) {
        pairs.push(i % 2 === 0 ? [a, b] : [b, a]);
      }
    }

    rounds.push(pairs);
    rot = [rot[rot.length - 1]!, ...rot.slice(0, -1)];
  }

  return rounds;
}

/**
 * Rounds, forever. Each complete pass through the circle flips home and away,
 * so pass 1 is the first leg and pass 2 the return leg. Two passes over an even
 * roster is exactly a double round-robin.
 */
function* roundStream(teamIds: readonly TeamId[]): Generator<Pairing[]> {
  const base = baseRounds(teamIds);
  if (base.length === 0) return;
  for (let pass = 0; ; pass++) {
    for (const round of base) {
      yield pass % 2 === 0 ? round : round.map(([home, away]) => [away, home] as const);
    }
  }
}

const pairKey = (a: TeamId, b: TeamId): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Every ordering of `items`. Only ever called with 7 or fewer positions. */
function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      yield [items[i]!, ...tail];
    }
  }
}

const PERMUTATION_LIMIT = 7;

/**
 * Choose which court each of a week's matches lands on.
 *
 * Rotating by week number looks fair but silently isn't: a team that always
 * occupies the same position in the round lands on the same court all season,
 * because the week index advances in lockstep with the round. So assign courts
 * by looking at what each team has actually had so far and minimising the
 * imbalance. Deterministic, and correct no matter how rounds line up with weeks.
 */
function assignPositions(
  weekMatches: readonly Pairing[],
  positions: readonly Position[],
  usage: Map<TeamId, Map<CourtId, number>>,
): Position[] {
  const usageOf = (team: TeamId, court: CourtId): number => usage.get(team)?.get(court) ?? 0;
  const costOf = (match: Pairing, position: Position): number =>
    usageOf(match[0], position.courtId) + usageOf(match[1], position.courtId);

  let chosen: Position[];

  if (positions.length <= PERMUTATION_LIMIT) {
    let best: Position[] | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const candidate of permutations(positions)) {
      const slice = candidate.slice(0, weekMatches.length);
      let cost = 0;
      for (let i = 0; i < weekMatches.length; i++) cost += costOf(weekMatches[i]!, slice[i]!);
      if (cost < bestCost) {
        bestCost = cost;
        best = slice;
      }
    }
    chosen = best ?? positions.slice(0, weekMatches.length);
  } else {
    // Greedy fallback for unusually wide nights.
    const remaining = [...positions];
    chosen = weekMatches.map((match) => {
      let bestIndex = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let i = 0; i < remaining.length; i++) {
        const cost = costOf(match, remaining[i]!);
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = i;
        }
      }
      return remaining.splice(bestIndex, 1)[0]!;
    });
  }

  for (let i = 0; i < weekMatches.length; i++) {
    const { courtId } = chosen[i]!;
    for (const team of weekMatches[i]!) {
      let byCourt = usage.get(team);
      if (!byCourt) {
        byCourt = new Map();
        usage.set(team, byCourt);
      }
      byCourt.set(courtId, (byCourt.get(courtId) ?? 0) + 1);
    }
  }

  return chosen;
}

/**
 * Build a schedule by laying round-robin rounds across the calendar.
 *
 * This is the right algorithm whenever every team is entitled to the same
 * number of weeks: balance is exact, opponent variety is provably optimal, and
 * no solver runs. Varied entitlements need the flow-and-anneal path instead.
 *
 * With 8 couples on 2 courts, 28 weeks yields a perfect double round-robin:
 * every couple meets every other couple exactly twice.
 */
export function buildRoundRobinSchedule(teams: readonly Team[], season: SeasonShape): Schedule {
  const { weeks, courts, slotsPerCourt } = season;

  if (teams.length < 2) throw new RangeError('roundRobin: need at least 2 teams');
  if (courts.length < 1) throw new RangeError('roundRobin: need at least 1 court');
  if (!Number.isInteger(slotsPerCourt) || slotsPerCourt < 1) {
    throw new RangeError(
      `roundRobin: slotsPerCourt must be a positive integer, got ${slotsPerCourt}`,
    );
  }
  if (new Set(teams.map((t) => t.id)).size !== teams.length) {
    throw new RangeError('roundRobin: team ids must be unique');
  }

  const teamIds = teams.map((t) => t.id);
  const matchesPerWeek = courts.length * slotsPerCourt;
  const seatsPerWeek = matchesPerWeek * 2;
  if (seatsPerWeek > teams.length) {
    throw new RangeError(
      `roundRobin: ${matchesPerWeek} matches per week needs ${seatsPerWeek} teams, ` +
        `but the roster has ${teams.length}`,
    );
  }

  const targetMatches = weeks.length * matchesPerWeek;
  const flat: Pairing[] = [];
  let rounds = 0;
  for (const round of roundStream(teamIds)) {
    flat.push(...round);
    rounds++;
    if (flat.length >= targetMatches) break;
  }
  flat.length = Math.min(flat.length, targetMatches);

  const positions: Position[] = [];
  for (let slotIndex = 0; slotIndex < slotsPerCourt; slotIndex++) {
    for (const courtId of courts) positions.push({ courtId, slotIndex });
  }

  const courtUsage = new Map<TeamId, Map<CourtId, number>>();
  const matches: Match[] = [];
  for (let week = 0; week * matchesPerWeek < flat.length; week++) {
    const weekMatches = flat.slice(week * matchesPerWeek, (week + 1) * matchesPerWeek);
    const placed = assignPositions(weekMatches, positions, courtUsage);
    weekMatches.forEach((pairing, i) => {
      matches.push({
        weekId: weeks[week] as WeekId,
        courtId: placed[i]!.courtId,
        slotIndex: placed[i]!.slotIndex,
        homeTeamId: pairing[0],
        awayTeamId: pairing[1],
      });
    });
  }

  const weeksByTeam: Record<TeamId, WeekId[]> = Object.fromEntries(
    teamIds.map((id) => [id, [] as WeekId[]]),
  );
  const meetings = new Map<string, number>();
  for (const match of matches) {
    weeksByTeam[match.homeTeamId]!.push(match.weekId);
    weeksByTeam[match.awayTeamId]!.push(match.weekId);
    const key = pairKey(match.homeTeamId, match.awayTeamId);
    meetings.set(key, (meetings.get(key) ?? 0) + 1);
  }

  // Pairs that never met count as zero, so walk every possible pairing rather
  // than only the ones that appear in the map.
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      const count = meetings.get(pairKey(teamIds[i]!, teamIds[j]!)) ?? 0;
      if (count < min) min = count;
      if (count > max) max = count;
    }
  }
  if (!Number.isFinite(min)) min = 0;

  return {
    matches,
    weeksByTeam,
    meta: {
      method: 'round-robin',
      rounds,
      matchesPerWeek,
      meetingsPerPair: { min, max },
      isPerfectDoubleRoundRobin: min === 2 && max === 2,
    },
  };
}
