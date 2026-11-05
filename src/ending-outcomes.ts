import type { AuthorContractApproval } from './author-contract.js';
import { AtomValueSchema, GuardSchema, type AtomValue, type Comparison, type Effect, type Guard } from './symbolic-graph.js';

export type EndingOutcome = Readonly<{ endingId: string; condition: Guard }>;
export type EndingOutcomeApproval = Readonly<{
  approval: AuthorContractApproval;
  revision: string;
  initialState: readonly AtomValue[];
  outcomes: readonly EndingOutcome[];
}>;

const atomKey = (comparison: Comparison) => JSON.stringify([comparison.ref.symbol, ...comparison.ref.args]);
const conditionKey = (condition: Guard) => JSON.stringify([...condition.all]
  .map((comparison) => JSON.stringify([comparison.ref.symbol, ...comparison.ref.args, comparison.value]))
  .sort());

function validateCondition(approval: AuthorContractApproval, condition: unknown): Guard {
  const parsed = GuardSchema.safeParse(condition);
  if (!parsed.success) throw new Error('Ending outcome condition is invalid');
  if (!parsed.data.all.length) throw new Error('Ending outcome condition must be nonempty');

  const entities = new Set([...approval.contract.entities.characters, ...approval.contract.entities.items, ...approval.contract.entities.locations]);
  const symbols = new Map([...approval.contract.stateSymbols, ...approval.contract.relationshipSymbols].map((symbol) => [symbol.id, symbol]));
  const atoms = new Set<string>();
  for (const comparison of parsed.data.all) {
    if (comparison.op !== 'eq') throw new Error('Ending outcome condition only allows eq comparisons');
    const symbol = symbols.get(comparison.ref.symbol);
    if (!symbol) throw new Error('Ending outcome condition references an unknown symbol');
    if (comparison.ref.args.length !== symbol.parameterCount) throw new Error('Ending outcome condition has incorrect symbol arity');
    if (comparison.ref.args.some((entity) => !entities.has(entity))) throw new Error('Ending outcome condition references an unknown entity');
    if (typeof comparison.value !== (symbol.type === 'number' ? 'number' : 'boolean')) throw new Error('Ending outcome condition value type does not match symbol');
    const key = atomKey(comparison);
    if (atoms.has(key)) throw new Error('Ending outcome condition has a duplicate atom');
    atoms.add(key);
  }
  return parsed.data;
}

function validateInitialState(approval: AuthorContractApproval, initialState: readonly unknown[]): AtomValue[] {
  const symbols = new Map([...approval.contract.stateSymbols, ...approval.contract.relationshipSymbols].map((symbol) => [symbol.id, symbol]));
  const entities = new Set([...approval.contract.entities.characters, ...approval.contract.entities.items, ...approval.contract.entities.locations]);
  const atoms = new Set<string>();
  return initialState.map((entry) => {
    const parsed = AtomValueSchema.safeParse(entry);
    if (!parsed.success) throw new Error('Ending outcome initial state is invalid');
    const symbol = symbols.get(parsed.data.ref.symbol);
    if (!symbol) throw new Error('Ending outcome initial state references an unknown symbol');
    if (parsed.data.ref.args.length !== symbol.parameterCount) throw new Error('Ending outcome initial state has incorrect symbol arity');
    if (parsed.data.ref.args.some((entity) => !entities.has(entity))) throw new Error('Ending outcome initial state references an unknown entity');
    if (typeof parsed.data.value !== (symbol.type === 'number' ? 'number' : 'boolean')) throw new Error('Ending outcome initial state value type does not match symbol');
    const key = atomKey({ ...parsed.data, op: 'eq' });
    if (atoms.has(key)) throw new Error('Ending outcome initial state has a duplicate atom');
    atoms.add(key);
    return parsed.data;
  });
}

export function approveEndingOutcomes(approval: AuthorContractApproval, revision: string, initialState: readonly unknown[], outcomes: readonly { endingId: string; condition?: unknown }[]): EndingOutcomeApproval {
  if (revision !== approval.revision) throw new Error('Ending outcome approval revision must match the Author Contract approval');
  const endingIds = approval.contract.endings.map((ending) => ending.id);
  if (outcomes.length !== endingIds.length || new Set(outcomes.map((outcome) => outcome.endingId)).size !== outcomes.length || outcomes.some((outcome) => !endingIds.includes(outcome.endingId))) {
    throw new Error('Ending outcome approval must contain exactly one outcome for every approved ending');
  }
  const validated = outcomes.map((outcome) => ({ endingId: outcome.endingId, condition: validateCondition(approval, outcome.condition) }));
  if (new Set(validated.map((outcome) => conditionKey(outcome.condition))).size !== validated.length) throw new Error('Ending outcome conditions must be distinguishable');
  const validatedInitialState = validateInitialState(approval, initialState);
  const outcomeAtoms = new Set(validated.flatMap((outcome) => outcome.condition.all.map(atomKey)));
  const initialAtoms = new Set(validatedInitialState.map((entry) => atomKey({ ...entry, op: 'eq' })));
  if ([...outcomeAtoms].some((atom) => !initialAtoms.has(atom))) throw new Error('Ending outcome initial state must contain every outcome condition atom');
  return { approval, revision, initialState: structuredClone(validatedInitialState), outcomes: structuredClone(validated) };
}

export function getEndingOutcome(approval: EndingOutcomeApproval, endingId: string): EndingOutcome {
  if (!approval.approval.contract.endings.some((ending) => ending.id === endingId)) throw new Error(`${endingId} is not an approved ending`);
  const outcome = approval.outcomes.find((candidate) => candidate.endingId === endingId);
  if (!outcome) throw new Error(`No approved ending outcome for ${endingId}`);
  return outcome;
}

export function compileEndingOutcomeEffects(outcome: EndingOutcome): Effect[] {
  const parsed = GuardSchema.safeParse(outcome.condition);
  if (!parsed.success || !parsed.data.all.length || parsed.data.all.some((comparison) => comparison.op !== 'eq')) {
    throw new Error('Ending outcome effects require a nonempty equality-only condition');
  }
  return [...parsed.data.all]
    .sort((left, right) => atomKey(left).localeCompare(atomKey(right)))
    .map(({ ref, value }) => ({ ref, op: 'set' as const, value }));
}
