export type {
  CourtId,
  Match,
  Schedule,
  ScheduleMeta,
  SeasonShape,
  Team,
  TeamId,
  WeekId,
} from './types.js';

export {
  checkEntitlements,
  computeCapacity,
  explainCapacity,
  type CapacityInput,
  type CapacityReport,
  type EntitlementCheck,
} from './capacity.js';

export { buildRoundRobinSchedule } from './roundRobin.js';

export {
  validateSchedule,
  type ValidateOptions,
  type Violation,
  type ViolationCode,
} from './validate.js';
