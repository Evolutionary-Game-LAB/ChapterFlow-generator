import { z } from 'zod';
import type { AuthorContractApproval } from './author-contract.js';

export const SYMBOLIC_ASSIGNMENT_LIMIT=24;

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const precisionNumber = (minimum: number, maximum: number) => z.number().finite().min(minimum).max(maximum).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-8, 'must use at most two decimal places');
const stateValue = z.union([z.boolean(), precisionNumber(0, 1)]);
const effectValue = z.union([z.boolean(), precisionNumber(-1, 1)]);

export const AtomRefSchema = z.object({ symbol: Id, args: z.array(Id).max(2) }).strict();
export const AtomValueSchema = z.object({ ref: AtomRefSchema, value: stateValue }).strict();
export const ComparisonSchema = z.object({ ref: AtomRefSchema, op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']), value: stateValue }).strict();
export const GuardSchema = z.object({ all: z.array(ComparisonSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT) }).strict();
export const EffectSchema = z.object({ ref: AtomRefSchema, op: z.enum(['set', 'add']), value: effectValue }).strict();
export const SituationDraftSchema = z.object({ id: Id, title: z.string().min(1).max(200), summary: z.string().min(1).max(4_000), locationId: Id, time: z.string().min(1).max(200), presentCharacters: z.array(Id).max(20), perspective: z.enum(['offscreen','outcome']).optional(), precondition: GuardSchema, endingId: Id.nullable() }).strict();
export const TransitionDraftSchema = z.object({ id: Id, from: Id, to: Id, label: z.string().min(1).max(200), precondition: GuardSchema, effects: z.array(EffectSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT) }).strict();
export const EndingRuleSchema = z.object({ endingId: Id, condition: GuardSchema }).strict();
export const SymbolicGraphDraftSchema = z.object({
  version: z.literal('1'), title: z.string().min(1).max(200), startSituationId: Id,
  initialState: z.array(AtomValueSchema).max(256), situations: z.array(SituationDraftSchema).min(1).max(64),
  transitions: z.array(TransitionDraftSchema).max(256), endingRules: z.array(EndingRuleSchema).max(6),
}).strict();

export type AtomRef = z.infer<typeof AtomRefSchema>;
export type AtomValue = z.infer<typeof AtomValueSchema>;
export type Comparison = z.infer<typeof ComparisonSchema>;
export type Guard = z.infer<typeof GuardSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type SituationDraft = z.infer<typeof SituationDraftSchema>;
export type TransitionDraft = z.infer<typeof TransitionDraftSchema>;
export type EndingRule = z.infer<typeof EndingRuleSchema>;
export type SymbolicGraphDraft = z.infer<typeof SymbolicGraphDraftSchema>;
export type SymbolicReferenceFinding = Readonly<{ path: string; message: string }>;

const idJsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 } as const;
const numberJsonSchema = { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.01 } as const;
const atomRefJsonSchema = { type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: { symbol: idJsonSchema, args: { type: 'array', items: idJsonSchema, maxItems: 2 } } } as const;
const guardJsonSchema = { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRefJsonSchema, op: { enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] }, value: { anyOf: [{ type: 'boolean' }, numberJsonSchema] } } } } } } as const;

export const symbolicGraphJsonSchema = {
  type: 'object', additionalProperties: false, required: ['version', 'title', 'startSituationId', 'initialState', 'situations', 'transitions', 'endingRules'], properties: {
    version: { const: '1' }, title: { type: 'string', minLength: 1, maxLength: 200 }, startSituationId: idJsonSchema,
    initialState: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['ref', 'value'], properties: { ref: atomRefJsonSchema, value: { anyOf: [{ type: 'boolean' }, numberJsonSchema] } } } },
    situations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'summary', 'locationId', 'time', 'presentCharacters', 'precondition', 'endingId'], properties: { id: idJsonSchema, title: { type: 'string', minLength: 1, maxLength: 200 }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, locationId: idJsonSchema, time: { type: 'string', minLength: 1, maxLength: 200 }, presentCharacters: { type: 'array', maxItems: 20, items: idJsonSchema }, precondition: guardJsonSchema, endingId: { anyOf: [idJsonSchema, { type: 'null' }] } } } },
    transitions: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['id', 'from', 'to', 'label', 'precondition', 'effects'], properties: { id: idJsonSchema, from: idJsonSchema, to: idJsonSchema, label: { type: 'string', minLength: 1, maxLength: 200 }, precondition: guardJsonSchema, effects: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRefJsonSchema, op: { enum: ['set', 'add'] }, value: { anyOf: [{ type: 'boolean' }, { type: 'number', minimum: -1, maximum: 1, multipleOf: 0.01 }] } } } } } } },
    endingRules: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['endingId', 'condition'], properties: { endingId: idJsonSchema, condition: guardJsonSchema } } },
  },
} as const;

export const symbolicGraphEnvelopeJsonSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'graph', 'issues'], properties: {
    status: { enum: ['ok', 'contract-insufficient'] },
    graph: { anyOf: [symbolicGraphJsonSchema, { type: 'null' }] },
    issues: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
  },
} as const;

const atomKey = (ref: AtomRef) => JSON.stringify([ref.symbol, ...ref.args]);
const pathFor = (parts: Array<string | number>): string => parts.reduce<string>((path, part) => typeof part === 'number' ? `${path}[${part}]` : `${path}.${part}`, '$');

export function validateSymbolicReferences(approval: AuthorContractApproval, draft: SymbolicGraphDraft): SymbolicReferenceFinding[] {
  const findings: SymbolicReferenceFinding[] = [];
  const add = (path: string, message: string) => findings.push({ path, message });
  const entities = new Set([...approval.contract.entities.characters, ...approval.contract.entities.items, ...approval.contract.entities.locations]);
  const locations = new Set(approval.contract.entities.locations);
  const symbols = new Map([...approval.contract.stateSymbols, ...approval.contract.relationshipSymbols].map((symbol) => [symbol.id, symbol]));
  const endings = new Set(approval.contract.endings.map((ending) => ending.id));
  const situations = new Set(draft.situations.map((situation) => situation.id));
  const situationIds = new Set<string>();
  const transitionIds = new Set<string>();
  const outgoing = new Map<string, number>();

  draft.situations.forEach((situation, index) => {
    if (situationIds.has(situation.id)) add(`$.situations[${index}].id`, 'duplicate situation ID');
    situationIds.add(situation.id);
  });
  draft.transitions.forEach((transition, index) => {
    if (transitionIds.has(transition.id)) add(`$.transitions[${index}].id`, 'duplicate transition ID');
    transitionIds.add(transition.id);
    const effectAtoms = new Set<string>();
    transition.effects.forEach((effect, effectIndex) => {
      const key = atomKey(effect.ref);
      if (effectAtoms.has(key)) add(`$.transitions[${index}].effects[${effectIndex}].ref`, 'duplicate effect atom');
      effectAtoms.add(key);
    });
  });

  if (!situations.has(draft.startSituationId)) add('$.startSituationId', 'unknown start situation');
  else if (draft.situations.find((situation) => situation.id === draft.startSituationId)?.endingId) add('$.startSituationId', 'start situation must be nonterminal');
  draft.transitions.forEach((transition, index) => {
    if (!situations.has(transition.from)) add(`$.transitions[${index}].from`, 'unknown source situation');
    if (!situations.has(transition.to)) add(`$.transitions[${index}].to`, 'unknown target situation');
    outgoing.set(transition.from, (outgoing.get(transition.from) ?? 0) + 1);
  });
  draft.situations.forEach((situation, index) => {
    if (!locations.has(situation.locationId)) add(`$.situations[${index}].locationId`, 'unknown location');
    situation.presentCharacters.forEach((character, characterIndex) => { if (!approval.contract.entities.characters.includes(character)) add(`$.situations[${index}].presentCharacters[${characterIndex}]`, 'unknown character'); });
    if (situation.endingId && !endings.has(situation.endingId)) add(`$.situations[${index}].endingId`, 'unknown ending');
    if (situation.perspective === 'outcome' && (!situation.endingId || situation.presentCharacters.length)) add(`$.situations[${index}].perspective`, 'outcome perspective is only for a terminal confirmation without physical cast');
    if (!situation.perspective && !situation.presentCharacters.includes(approval.playerId)) add(`$.situations[${index}].presentCharacters`, 'situation must include the approved player');
    const count = outgoing.get(situation.id) ?? 0;
    if (situation.endingId && count) add(`$.situations[${index}].endingId`, 'terminal situation has outgoing transitions');
    if (!situation.endingId && !count) add(`$.situations[${index}]`, 'nonterminal situation has no outgoing transition');
  });
  const ruleIds = draft.endingRules.map((rule) => rule.endingId);
  if (ruleIds.length !== endings.size || new Set(ruleIds).size !== ruleIds.length || ruleIds.some((id) => !endings.has(id)) || [...endings].some((id) => !ruleIds.includes(id))) add('$.endingRules', 'must contain exactly one rule for every approved ending');

  const initial = new Map<string, number>();
  draft.initialState.forEach((entry, index) => {
    const key = atomKey(entry.ref);
    if (initial.has(key)) add(`$.initialState[${index}].ref`, 'duplicate initial atom');
    else initial.set(key, index);
  });
  const references: Array<{ ref: AtomRef; path: string; kind: 'initial' | 'comparison' | 'effect'; op?: string; value: boolean | number }> = [];
  draft.initialState.forEach((entry, index) => references.push({ ...entry, path: `$.initialState[${index}].ref`, kind: 'initial' }));
  const addGuard = (guard: Guard, base: Array<string | number>) => guard.all.forEach((comparison, index) => references.push({ ...comparison, path: pathFor([...base, 'all', index, 'ref']), kind: 'comparison' }));
  draft.situations.forEach((situation, index) => addGuard(situation.precondition, ['situations', index, 'precondition']));
  draft.transitions.forEach((transition, index) => { addGuard(transition.precondition, ['transitions', index, 'precondition']); transition.effects.forEach((effect, effectIndex) => references.push({ ...effect, path: `$.transitions[${index}].effects[${effectIndex}].ref`, kind: 'effect' })); });
  draft.endingRules.forEach((rule, index) => addGuard(rule.condition, ['endingRules', index, 'condition']));

  const missing = new Set<string>();
  for (const reference of references) {
    const symbol = symbols.get(reference.ref.symbol);
    if (!symbol) { add(`${reference.path}.symbol`, 'unknown symbol'); continue; }
    if (reference.ref.args.length !== symbol.parameterCount) { add(`${reference.path}.args`, `expected ${symbol.parameterCount} arguments`); continue; }
    reference.ref.args.forEach((arg, index) => { if (!entities.has(arg)) add(`${reference.path}.args[${index}]`, 'unknown entity'); });
    const numberSymbol = symbol.type === 'number';
    if (typeof reference.value !== (numberSymbol ? 'number' : 'boolean')) add(reference.path.replace(/\.ref$/, '.value'), 'value type does not match symbol');
    if (reference.kind === 'comparison' && !numberSymbol && reference.op !== 'eq' && reference.op !== 'ne') add(reference.path.replace(/\.ref$/, '.op'), 'boolean comparisons only allow eq or ne');
    if (reference.kind === 'effect' && (!numberSymbol && reference.op !== 'set')) add(reference.path.replace(/\.ref$/, '.op'), 'boolean effects only allow set');
    if (reference.kind === 'effect' && reference.op === 'set' && typeof reference.value === 'number' && (reference.value < 0 || reference.value > 1)) add(reference.path.replace(/\.ref$/, '.value'), 'numeric set must be within 0..1');
    const key = atomKey(reference.ref);
    if (reference.kind !== 'initial' && !initial.has(key) && !missing.has(key)) { add(reference.path, 'referenced atom is missing an initial value'); missing.add(key); }
  }
  return findings;
}

export function parseSymbolicGraph(approval: AuthorContractApproval, raw: unknown): Readonly<{ approval: AuthorContractApproval; draft: SymbolicGraphDraft }> {
  const parsed = SymbolicGraphDraftSchema.safeParse(raw);
  if (!parsed.success) { const issue = parsed.error.issues[0]!; throw new Error(`Symbolic Graph 오류 (${pathFor(issue.path)}): ${issue.message}`); }
  const findings = validateSymbolicReferences(approval, parsed.data);
  if (findings.length) throw new Error(`Symbolic Graph 오류 (${findings[0]!.path}): ${findings[0]!.message}`);
  return { approval, draft: parsed.data };
}
