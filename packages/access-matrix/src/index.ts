export { ACTIONS, ACTION_NAMES, STAGES } from './model.js';
export type {
  Action,
  ActionSpec,
  Basis,
  Batch,
  Correction,
  Dashboard,
  DelegableTask,
  Delegation,
  DepartmentDuty,
  Grant,
  Offering,
  OfferingDuty,
  Outcome,
  Principal,
  ResourceType,
  Result,
  Role,
  Scope,
  Separation,
  SeparationCode,
  SeparationRule,
  Stage,
  Via,
  World,
} from './model.js';
export { DECISIONS, DELEGABLE, GRANTS, SEPARATIONS } from './policy.js';
export { decide, enumerateCases, resourcesFor } from './evaluate.js';
export type { AccessCase, Decision } from './evaluate.js';
export { PILOT_WORLD } from './fixture.js';
export { renderMatrix } from './render.js';
