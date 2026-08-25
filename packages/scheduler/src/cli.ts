/**
 * Preview a season from the command line.
 *
 * The scheduler is deliberately free of database imports, so it can be run
 * against a hypothetical league before any of it exists:
 *
 *   pnpm --filter @deuce/scheduler preview
 *   pnpm --filter @deuce/scheduler preview -- --weeks 28 --waves 2
 */
import { computeCapacity, explainCapacity } from './capacity.js';
import { buildRoundRobinSchedule } from './roundRobin.js';
import { validateSchedule } from './validate.js';
import type { SeasonShape, Team } from './types.js';

const DEFAULT_COUPLES = [
  'Domingo', 'Hoffman', 'Reyes', 'Whitaker',
  'Nakamura', 'Okafor', 'Bergstrom', 'Silva',
];

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`--${name} needs a positive integer, got ${process.argv[index + 1]}`);
  }
  return parsed;
}

function main(): void {
  const weeks = flag('weeks', 26);
  const courts = flag('courts', 2);
  const waves = flag('waves', 1);
  const coupleCount = flag('couples', 8);

  const teams: Team[] = Array.from({ length: coupleCount }, (_, i) => ({
    id: `t${i}`,
    name: DEFAULT_COUPLES[i] ?? `Couple ${i + 1}`,
  }));

  const season: SeasonShape = {
    weeks: Array.from({ length: weeks }, (_, i) => `w${i + 1}`),
    courts: Array.from({ length: courts }, (_, i) => `Court ${i + 1}`),
    slotsPerCourt: waves,
  };

  const capacity = computeCapacity({ weeks, courts, slotsPerCourt: waves, teams: teams.length });

  console.log(`\n  DEUCE  ${teams.length} couples / ${courts} courts / ${waves} wave(s) / ${weeks} weeks\n`);
  console.log('  CAPACITY');
  for (const line of explainCapacity({ weeks, courts, slotsPerCourt: waves, teams: teams.length })) {
    console.log(`  - ${line}`);
  }

  const schedule = buildRoundRobinSchedule(teams, season);
  const entitlements = Object.fromEntries(teams.map((t) => [t.id, capacity.recommendedCap]));
  const violations = validateSchedule(teams, season, schedule, { entitlements });

  console.log('\n  SCHEDULE');
  console.log(`  - ${schedule.matches.length} matches over ${schedule.meta.rounds} rounds.`);
  console.log(
    `  - Each pair meets between ${schedule.meta.meetingsPerPair.min} and ` +
      `${schedule.meta.meetingsPerPair.max} times.`,
  );
  console.log(
    schedule.meta.isPerfectDoubleRoundRobin
      ? '  - PERFECT double round-robin: every couple meets every other exactly twice.'
      : '  - Not a perfect double round-robin at this length.',
  );
  console.log(
    violations.length === 0
      ? `  - Valid, and every couple is scheduled for their ${capacity.recommendedCap} purchased weeks.`
      : `  - ${violations.length} violation(s):\n${violations.map((v) => `      ${v.message}`).join('\n')}`,
  );

  const byName = new Map(teams.map((t) => [t.id, t.name]));
  console.log('\n  FIRST FOUR WEEKS');
  for (const weekId of season.weeks.slice(0, 4)) {
    const inWeek = schedule.matches.filter((m) => m.weekId === weekId);
    const idle = teams
      .filter((t) => !inWeek.some((m) => m.homeTeamId === t.id || m.awayTeamId === t.id))
      .map((t) => t.name);
    console.log(`\n  ${weekId}`);
    for (const m of inWeek) {
      const wave = waves > 1 ? ` wave ${m.slotIndex + 1}` : '';
      console.log(
        `    ${m.courtId}${wave}: ${byName.get(m.homeTeamId)} vs ${byName.get(m.awayTeamId)}`,
      );
    }
    if (idle.length > 0) console.log(`    off: ${idle.join(', ')}`);
  }
  console.log('');
}

main();
