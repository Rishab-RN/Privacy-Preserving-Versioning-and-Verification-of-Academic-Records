import { ACTIONS, STAGES } from './model.js';
import type {
  Action,
  Grant,
  Outcome,
  Principal,
  ResourceType,
  SeparationRule,
  Stage,
  Via,
  World,
} from './model.js';
import { GRANTS, SEPARATIONS } from './policy.js';

/** Facts about a resource that scopes and separation rules need. */
interface Context {
  readonly offering?: string;
  readonly department?: string | null;
  readonly term?: string;
  readonly stage?: Stage;
  readonly student?: string;
  readonly published?: boolean;
  readonly batch?: string;
  readonly correction?: string;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Unknown ${what}`);
  return value;
}

function offeringContext(world: World, key: string): Context {
  const offering = need(world.offerings[key], `offering ${key}`);
  return {
    offering: key,
    department: offering.department,
    term: offering.term,
    published: offering.published,
  };
}

function context(world: World, type: ResourceType, key: string): Context {
  switch (type) {
    case 'offering':
      return offeringContext(world, key);
    case 'offering-stage': {
      const [offering = '', stage] = key.split(':');
      if (!STAGES.includes(stage as Stage)) throw new Error(`Unknown offering stage ${key}`);
      return { ...offeringContext(world, offering), stage: stage as Stage };
    }
    case 'batch': {
      const batch = need(world.batches[key], `batch ${key}`);
      return { ...offeringContext(world, batch.offering), stage: batch.stage, batch: key };
    }
    case 'result': {
      const result = need(world.results[key], `result ${key}`);
      return { ...offeringContext(world, result.offering), student: result.student };
    }
    case 'correction': {
      const correction = need(world.corrections[key], `correction ${key}`);
      return { ...context(world, 'result', correction.result), correction: key };
    }
    case 'dashboard': {
      const dashboard = need(world.dashboards[key], `dashboard ${key}`);
      return { department: dashboard.department, term: dashboard.term };
    }
    case 'institution':
    case 'public':
      return {};
  }
}

/** Resource keys an action can target in a world, in a stable order. */
export function resourcesFor(world: World, action: Action): readonly string[] {
  const type: ResourceType = ACTIONS[action].resource;
  switch (type) {
    case 'offering':
      return Object.keys(world.offerings);
    case 'offering-stage':
      return Object.keys(world.offerings).flatMap((key) =>
        STAGES.map((stage) => `${key}:${stage}`),
      );
    case 'batch':
      return Object.keys(world.batches);
    case 'result':
      return Object.keys(world.results);
    case 'correction':
      return Object.keys(world.corrections);
    case 'dashboard':
      return Object.keys(world.dashboards);
    case 'institution':
      return ['institution'];
    case 'public':
      return ['public'];
  }
}

function activeDelegations(world: World, principal: Principal) {
  const now = Date.parse(world.now);
  return (principal.delegations ?? []).filter(
    (delegation) =>
      Date.parse(delegation.validFrom) <= now && now < Date.parse(delegation.validUntil),
  );
}

/** Whether the principal currently holds what the grant names, anywhere. */
function holds(world: World, principal: Principal, via: Via): boolean {
  switch (via.kind) {
    case 'role':
      return principal.roles.includes(via.role);
    case 'offering':
      return (principal.offeringDuties ?? []).some((duty) => duty.duty === via.duty);
    case 'department':
      return (principal.departmentDuties ?? []).some((duty) => duty.duty === via.duty);
    case 'delegation':
      return activeDelegations(world, principal).some((delegation) =>
        delegation.tasks.includes(via.task),
      );
  }
}

function stageMatches(via: Via, ctx: Context) {
  return !('stage' in via) || via.stage === undefined || via.stage === ctx.stage;
}

function covers(world: World, key: string, principal: Principal, grant: Grant, ctx: Context) {
  const { via } = grant;
  switch (grant.scope) {
    case 'institution':
      return true;
    case 'own':
      return ctx.student !== undefined && ctx.student === principal.student;
    case 'own-published':
      return ctx.student !== undefined && ctx.student === principal.student && !!ctx.published;
    case 'assigned':
    case 'authored': {
      if (via.kind !== 'offering' || !stageMatches(via, ctx)) return false;
      const assigned = (principal.offeringDuties ?? []).some(
        (duty) => duty.offering === ctx.offering && duty.duty === via.duty,
      );
      if (grant.scope === 'assigned') return assigned;
      return assigned && ctx.batch !== undefined && world.batches[ctx.batch]?.author === key;
    }
    case 'department':
      return (
        via.kind === 'department' &&
        stageMatches(via, ctx) &&
        (principal.departmentDuties ?? []).some(
          (duty) =>
            duty.duty === via.duty && duty.department === ctx.department && duty.term === ctx.term,
        )
      );
    case 'delegated':
      return (
        via.kind === 'delegation' &&
        activeDelegations(world, principal).some(
          (delegation) =>
            delegation.tasks.includes(via.task) &&
            delegation.term === ctx.term &&
            ctx.department !== undefined &&
            ctx.department !== null &&
            delegation.departments.includes(ctx.department),
        )
      );
  }
}

function conflicts(world: World, key: string, rule: SeparationRule, ctx: Context): boolean {
  const batch = ctx.batch ? world.batches[ctx.batch] : undefined;
  const offeringBatches = Object.values(world.batches).filter((b) => b.offering === ctx.offering);
  switch (rule) {
    case 'batch-author':
      return batch?.author === key;
    case 'batch-validator':
      return !!batch?.validators.includes(key);
    case 'batch-reviewer':
      return batch?.reviewer === key;
    case 'offering-participant':
      return offeringBatches.some(
        (b) => b.author === key || b.reviewer === key || b.validators.includes(key),
      );
    case 'correction-proposer':
      return !!ctx.correction && world.corrections[ctx.correction]?.proposer === key;
    case 'record-author':
      return offeringBatches.some((b) => b.author === key);
  }
}

export interface Decision {
  readonly outcome: Outcome;
  /** Index into `GRANTS` of the first grant that allowed the request. */
  readonly grant?: number;
}

/**
 * Expected outcome for a principal (or `null` for an anonymous caller) performing an action on a
 * resource. The order mirrors the API convention: 401 without a session, 403 when the caller can
 * never perform the action, 404 when the resource is outside every scope they hold, then
 * separation-of-duties denials.
 */
export function decide(
  world: World,
  principalKey: string | null,
  action: Action,
  resourceKey: string,
): Decision {
  const spec = ACTIONS[action];
  const ctx = context(world, spec.resource, resourceKey);
  if (spec.resource === 'public') return { outcome: { status: 200, code: 'ALLOWED' } };
  if (principalKey === null) return { outcome: { status: 401, code: 'UNAUTHENTICATED' } };
  const principal = need(world.principals[principalKey], `principal ${principalKey}`);

  const capable = GRANTS.map((grant, index) => ({ grant, index })).filter(
    ({ grant }) => grant.action === action && holds(world, principal, grant.via),
  );
  if (capable.length === 0) return { outcome: { status: 403, code: 'FORBIDDEN' } };

  const covering = capable.find(({ grant }) => covers(world, principalKey, principal, grant, ctx));
  if (!covering) return { outcome: { status: 404, code: 'NOT_FOUND' } };

  for (const separation of SEPARATIONS) {
    if (separation.action === action && conflicts(world, principalKey, separation.when, ctx)) {
      return { outcome: { status: 403, code: separation.code } };
    }
  }
  return { outcome: { status: 200, code: 'ALLOWED' }, grant: covering.index };
}

export interface AccessCase {
  readonly principal: string | null;
  readonly action: Action;
  readonly resource: string;
  readonly expected: Outcome;
}

/**
 * Every principal (plus an anonymous caller) against every action and every resource that action
 * can target. Integration tests map each case to a real request and compare status and code.
 */
export function enumerateCases(world: World): AccessCase[] {
  const principals: (string | null)[] = [...Object.keys(world.principals), null];
  const cases: AccessCase[] = [];
  for (const principal of principals) {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      for (const resource of resourcesFor(world, action)) {
        cases.push({
          principal,
          action,
          resource,
          expected: decide(world, principal, action, resource).outcome,
        });
      }
    }
  }
  return cases;
}
