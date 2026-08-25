/** Stable identifiers supplied by the caller; the scheduler never invents them. */
export type TeamId = string;
export type CourtId = string;
export type WeekId = string;

export interface Team {
  id: TeamId;
  name: string;
}

/**
 * The physical shape of a season: which weeks are playable, which courts are
 * booked, and how many waves run on a league night.
 *
 * `slotsPerCourt` is the single highest-leverage number in the whole system.
 * At 1 (one start time) an 8-couple league on 2 courts can sell 13 weeks; at 2
 * (e.g. 6:00 and 7:30) it can sell all 26.
 */
export interface SeasonShape {
  /** Playing weeks in calendar order. Excludes flex/makeup weeks held in reserve. */
  weeks: WeekId[];
  courts: CourtId[];
  /** Simultaneous waves per court per night. 1 = single start time. */
  slotsPerCourt: number;
}

export interface Match {
  weekId: WeekId;
  courtId: CourtId;
  /** 0-based wave index within the night. */
  slotIndex: number;
  homeTeamId: TeamId;
  awayTeamId: TeamId;
}

export interface Schedule {
  matches: Match[];
  /** Weeks each team is on court, in calendar order. */
  weeksByTeam: Record<TeamId, WeekId[]>;
  meta: ScheduleMeta;
}

export interface ScheduleMeta {
  method: 'round-robin' | 'flow+anneal';
  /** Complete round-robin rounds emitted (a round = every team plays once). */
  rounds: number;
  matchesPerWeek: number;
  /** How many times each unordered pair of teams meets across the season. */
  meetingsPerPair: { min: number; max: number };
  /** True when every pair meets exactly twice — a perfect double round-robin. */
  isPerfectDoubleRoundRobin: boolean;
}
