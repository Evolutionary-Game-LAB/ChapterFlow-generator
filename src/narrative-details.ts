import {SYMBOLIC_ASSIGNMENT_LIMIT} from './symbolic-graph.js';
import { z } from 'zod';
import type { AuthorContract, AuthorContractApproval } from './author-contract.js';
import { compileEndingOutcomeEffects, getEndingOutcome, type EndingOutcomeApproval } from './ending-outcomes.js';
import type { NarrativeSkeleton } from './narrative-skeleton.js';
import { AtomValueSchema, EffectSchema, GuardSchema } from './symbolic-graph.js';

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const SceneBase = { key: Id, summary: z.string().min(1).max(4_000), locationId: Id, presentCharacters: z.array(Id).max(20), perspective: z.enum(['offscreen','outcome']).optional(), precondition: GuardSchema };
const ActionSchema = z.object({ to: Id, precondition: GuardSchema, effects: z.array(EffectSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT) }).strict();
const TerminalSceneSchema = z.object({ ...SceneBase, terminal: z.object({ condition: GuardSchema }).strict() }).strict();
const ActionSceneSchema = z.object({ ...SceneBase, actions: z.array(ActionSchema).min(1).max(16) }).strict();


export const NarrativeDetailsSchema = z.object({
  initialState: z.array(AtomValueSchema).max(256),
  scenes: z.array(z.union([TerminalSceneSchema, ActionSceneSchema])).min(1).max(64),
}).strict();

export type NarrativeDetails = z.infer<typeof NarrativeDetailsSchema>;
export type NarrativeDetailsJsonSchema = Record<string, any>;

const idJsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 };
const numberJsonSchema = (minimum = 0, maximum = 1) => ({ type: 'number', minimum, maximum, multipleOf: 0.01 });
const noMatch = { type: 'string', minLength: 1, maxLength: 0 };
const enumOrNoMatch = (values: string[]) => values.length ? { enum: values } : noMatch;

export function narrativeDetailsJsonSchemaFor(contract: AuthorContract, skeleton: NarrativeSkeleton): NarrativeDetailsJsonSchema {
  const entities = [...contract.entities.characters, ...contract.entities.items, ...contract.entities.locations];
  const symbols = [...contract.stateSymbols, ...contract.relationshipSymbols];
  const atomRef = (symbol: typeof symbols[number]) => ({ type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: { symbol: { const: symbol.id }, args: { type: 'array', minItems: symbol.parameterCount, maxItems: symbol.parameterCount, items: enumOrNoMatch(entities) } } });
  const value = (symbol: typeof symbols[number]) => symbol.type === 'boolean' ? { type: 'boolean' } : numberJsonSchema(...('range' in symbol && symbol.range ? symbol.range : [0, 1]));
  const oneOf = (items: NarrativeDetailsJsonSchema[]) => items.length ? { oneOf: items } : noMatch;
  const initialItem = oneOf(symbols.map((symbol) => ({ type: 'object', additionalProperties: false, required: ['ref', 'value'], properties: { ref: atomRef(symbol), value: value(symbol) } })));
  const comparisonItem = oneOf(symbols.map((symbol) => ({ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { enum: symbol.type === 'boolean' ? ['eq', 'ne'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] }, value: value(symbol) } })));
  const effectItem = oneOf(symbols.flatMap((symbol) => symbol.type === 'boolean'
    ? [{ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: { type: 'boolean' } } }]
    : [{ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: value(symbol) } }, { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'add' }, value: numberJsonSchema(-1, 1) } }]));
  const guard = { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: comparisonItem } } };
  const base = (key: string) => ({ key: { const: key }, summary: { type: 'string', minLength: 1, maxLength: 4_000 }, locationId: enumOrNoMatch(contract.entities.locations), presentCharacters: { type: 'array', maxItems: 20, items: enumOrNoMatch(contract.entities.characters) }, precondition: guard });
  const variants = skeleton.scenes.map((scene) => {
    const sceneBase = base(scene.key);
    if (scene.endingId) return { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBase), 'terminal'], properties: { ...sceneBase, terminal: { type: 'object', additionalProperties: false, required: ['condition'], properties: { condition: guard } } } };
    const targets = skeleton.links.filter((link) => link.from === scene.key).map((link) => link.to);
    return { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBase), 'actions'], properties: { ...sceneBase, actions: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['to', 'precondition', 'effects'], properties: { to: enumOrNoMatch(targets), precondition: guard, effects: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: effectItem } } } } } };
  });
  return { type: 'object', additionalProperties: false, required: ['initialState', 'scenes'], properties: { initialState: { type: 'array', maxItems: 256, items: initialItem }, scenes: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: variants } } } };
}

export type NarrativePlanDetails = Readonly<{ initialState: NarrativeDetails['initialState']; scenes: Record<string, unknown> }>;
export type OutcomeBoundNarrativePlanDetails = Readonly<{ format?: 'stateful-v1'; scenes: Record<string, unknown> }>;

export const NarrativePlanDetailsSchema = z.object({ initialState: z.array(AtomValueSchema).max(256), scenes: z.record(z.unknown()) }).strict();

export function narrativePlanDetailsJsonSchemaFor(contract: AuthorContract, skeleton: NarrativeSkeleton): NarrativeDetailsJsonSchema {
  const entities = [...contract.entities.characters, ...contract.entities.items, ...contract.entities.locations];
  const symbols = [...contract.stateSymbols, ...contract.relationshipSymbols];
  const atomRef = (symbol: typeof symbols[number]) => ({ type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: { symbol: { const: symbol.id }, args: { type: 'array', minItems: symbol.parameterCount, maxItems: symbol.parameterCount, items: enumOrNoMatch(entities) } } });
  const value = (symbol: typeof symbols[number]) => symbol.type === 'boolean' ? { type: 'boolean' } : numberJsonSchema(...('range' in symbol && symbol.range ? symbol.range : [0, 1]));
  const oneOf = (items: NarrativeDetailsJsonSchema[]) => items.length ? { oneOf: items } : noMatch;
  const initialItem = oneOf(symbols.map((symbol) => ({ type: 'object', additionalProperties: false, required: ['ref', 'value'], properties: { ref: atomRef(symbol), value: value(symbol) } })));
  const comparisonItem = oneOf(symbols.map((symbol) => ({ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { enum: symbol.type === 'boolean' ? ['eq', 'ne'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] }, value: value(symbol) } })));
  const effectItem = oneOf(symbols.flatMap((symbol) => symbol.type === 'boolean'
    ? [{ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: { type: 'boolean' } } }]
    : [{ type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: value(symbol) } }, { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'add' }, value: numberJsonSchema(-1, 1) } }]));
  const guard = { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: comparisonItem } } };
  const base = { summary: { type: 'string', minLength: 1, maxLength: 4_000 }, locationId: enumOrNoMatch(contract.entities.locations), presentCharacters: { type: 'array', maxItems: 20, items: enumOrNoMatch(contract.entities.characters) }, precondition: guard };
  const properties = Object.fromEntries(skeleton.scenes.map((scene) => {
    if (scene.endingId) return [scene.key, { type: 'object', additionalProperties: false, required: [...Object.keys(base), 'terminal'], properties: { ...base, terminal: { type: 'object', additionalProperties: false, required: ['condition'], properties: { condition: guard } } } }];
    const targets = skeleton.links.filter((link) => link.from === scene.key).map((link) => link.to);
    return [scene.key, { type: 'object', additionalProperties: false, required: [...Object.keys(base), 'actions'], properties: { ...base, actions: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['to', 'precondition', 'effects'], properties: { to: enumOrNoMatch(targets), precondition: guard, effects: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: effectItem } } } } } }];
  }));
  return { type: 'object', additionalProperties: false, required: ['initialState', 'scenes'], properties: { initialState: { type: 'array', maxItems: 256, items: initialItem }, scenes: { type: 'object', additionalProperties: false, required: skeleton.scenes.map((scene) => scene.key), properties } } };
}

export function parseNarrativePlanDetails(raw: unknown, approval: AuthorContractApproval, skeleton: NarrativeSkeleton): NarrativeDetails {
  const parsed = NarrativePlanDetailsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Narrative Plan Details 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const keys = new Set(skeleton.scenes.map((scene) => scene.key));
  for (const key of Object.keys(parsed.data.scenes)) if (!keys.has(key)) throw new Error(`Narrative Plan Details 오류 (scenes): scene '${key}' is not in skeleton`);
  for (const scene of skeleton.scenes) if (!(scene.key in parsed.data.scenes)) throw new Error(`Narrative Plan Details 오류 (scenes): missing detail scene '${scene.key}'`);
  try {
    return parseNarrativeDetails({ initialState: parsed.data.initialState, scenes: skeleton.scenes.map((scene) => ({ ...(parsed.data.scenes[scene.key] as object), key: scene.key })) }, approval, skeleton);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : 'parse failed').replace('Narrative Details 오류', 'Narrative Plan Details 오류'));
  }
}

export function outcomeBoundNarrativePlanDetailsJsonSchemaFor(contract: AuthorContract, skeleton: NarrativeSkeleton): NarrativeDetailsJsonSchema {
  const entry = {
    type: 'object', additionalProperties: false, required: ['summary', 'locationId', 'presentCharacters'],
    properties: { summary: { type: 'string', minLength: 1, maxLength: 4_000 }, locationId: enumOrNoMatch(contract.entities.locations), presentCharacters: { type: 'array', maxItems: 20, items: enumOrNoMatch(contract.entities.characters) } },
  };
  return { type: 'object', additionalProperties: false, required: ['scenes'], properties: { scenes: { type: 'object', additionalProperties: false, required: skeleton.scenes.map((scene) => scene.key), properties: Object.fromEntries(skeleton.scenes.map((scene) => [scene.key, entry])) } } };
}

export const OutcomeBoundPlanDetailsSchema = z.object({ format: z.literal('stateful-v1').optional(), scenes: z.record(z.unknown()) }).strict();

export function parseOutcomeBoundNarrativePlanDetailsResult(raw: unknown, approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, skeleton: NarrativeSkeleton): Readonly<{ details: OutcomeBoundNarrativePlanDetails; compiled: NarrativeDetails }> {
  if (outcomes.approval !== approval || outcomes.revision !== approval.revision) throw new Error('Ending outcome approval must match the Author Contract approval identity and revision');
  const parsed = OutcomeBoundPlanDetailsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Outcome-bound Plan Details 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const keys = new Set(skeleton.scenes.map((scene) => scene.key));
  for (const key of Object.keys(parsed.data.scenes)) if (!keys.has(key)) throw new Error(`Outcome-bound Plan Details 오류 (scenes): scene '${key}' is not in skeleton`);
  for (const scene of skeleton.scenes) if (!(scene.key in parsed.data.scenes)) throw new Error(`Outcome-bound Plan Details 오류 (scenes): missing detail scene '${scene.key}'`);
  if (parsed.data.format === 'stateful-v1') return parseStatefulOutcomeDetails(parsed.data, approval, outcomes, skeleton);
  const entry = z.object({ summary: z.string().min(1).max(4_000), locationId: z.enum(approval.contract.entities.locations as [string, ...string[]]), presentCharacters: z.array(z.enum(approval.contract.entities.characters as [string, ...string[]])).max(20) }).strict();
  const endingTargets = new Map(skeleton.scenes.filter((scene) => scene.endingId).map((scene) => [scene.key, scene.endingId!]));
  const scenes = skeleton.scenes.map((scene) => {
    const detail = entry.safeParse(parsed.data.scenes[scene.key]);
    if (!detail.success) throw new Error(`Outcome-bound Plan Details 오류 (scenes.${scene.key}): ${detail.error.issues[0]!.message}`);
    if (scene.endingId) return { ...detail.data, key: scene.key, precondition: { all: [] }, terminal: { condition: getEndingOutcome(outcomes, scene.endingId).condition } };
    return { ...detail.data, key: scene.key, precondition: { all: [] }, actions: skeleton.links.filter((link) => link.from === scene.key).map((link) => ({ to: link.to, precondition: { all: [] }, effects: endingTargets.has(link.to) ? compileEndingOutcomeEffects(getEndingOutcome(outcomes, endingTargets.get(link.to)!)) : [] })) };
  });
  return { details: raw as OutcomeBoundNarrativePlanDetails, compiled: parseNarrativeDetails({ initialState: outcomes.initialState, scenes }, approval, skeleton) };
}

export function parseOutcomeBoundNarrativePlanDetails(raw: unknown, approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, skeleton: NarrativeSkeleton): NarrativeDetails {
  return parseOutcomeBoundNarrativePlanDetailsResult(raw, approval, outcomes, skeleton).compiled;
}

export function parseNarrativeDetails(raw: unknown, _approval: AuthorContractApproval, skeleton: NarrativeSkeleton): NarrativeDetails {
  const parsed = NarrativeDetailsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Narrative Details 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const details = parsed.data;
  const skeletonScenes = new Map(skeleton.scenes.map((scene) => [scene.key, scene]));
  const seen = new Set<string>();
  for (const [index, scene] of details.scenes.entries()) {
    const skeletonScene = skeletonScenes.get(scene.key);
    if (!skeletonScene) throw new Error(`Narrative Details 오류 (scenes.${index}.key): scene '${scene.key}' is not in skeleton`);
    if (seen.has(scene.key)) throw new Error(`Narrative Details 오류 (scenes.${index}.key): duplicate detail scene '${scene.key}'`);
    seen.add(scene.key);
    const terminal = 'terminal' in scene;
    if (Boolean(skeletonScene.endingId) !== terminal) throw new Error(`Narrative Details 오류 (scenes.${index}): terminal role does not match skeleton`);
    if (!terminal) {
      const targets = skeleton.links.filter((link) => link.from === scene.key).map((link) => link.to);
      const actionTargets = new Set<string>();
      for (const action of scene.actions) {
        if (actionTargets.has(action.to)) throw new Error(`Narrative Details 오류 (scenes.${index}.actions): duplicate action target '${action.to}'`);
        actionTargets.add(action.to);
        if (!targets.includes(action.to)) throw new Error(`Narrative Details 오류 (scenes.${index}.actions): action target '${action.to}' is not a skeleton link`);
      }
      for (const target of targets) if (!actionTargets.has(target)) throw new Error(`Narrative Details 오류 (scenes.${index}.actions): missing action target '${target}'`);
      if (scene.actions.length !== targets.length) throw new Error(`Narrative Details 오류 (scenes.${index}.actions): actions must exactly match skeleton links`);
    }
  }
  for (const scene of skeleton.scenes) if (!seen.has(scene.key)) throw new Error(`Narrative Details 오류 (scenes): missing detail scene '${scene.key}'`);
  return details;
}

/** Stateful details for new storyline plans; legacy prose maps keep their old semantics. */
export function statefulOutcomeDetailsJsonSchemaFor(contract: AuthorContract, skeleton: NarrativeSkeleton): NarrativeDetailsJsonSchema {
  const schema = narrativePlanDetailsJsonSchemaFor(contract, skeleton);
  const scenes = schema.properties.scenes;
  for (const scene of skeleton.scenes) {
    if (!scene.endingId) continue;
    const entry = scenes.properties[scene.key];
    delete entry.properties.terminal;
    entry.required = entry.required.filter((key: string) => key !== 'terminal');
  }
  return { type: 'object', additionalProperties: false, required: ['format', 'scenes'], properties: { format: { const: 'stateful-v1' }, scenes } };
}

function parseStatefulOutcomeDetails(raw: unknown, approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, skeleton: NarrativeSkeleton): Readonly<{ details: OutcomeBoundNarrativePlanDetails; compiled: NarrativeDetails }> {
  const parsed = OutcomeBoundPlanDetailsSchema.parse(raw);
  const known = new Set(skeleton.scenes.map((scene) => scene.key));
  for (const key of Object.keys(parsed.scenes)) if (!known.has(key)) throw new Error("Outcome-bound Plan Details 오류: unknown scene " + key);
  const sceneBase = {
    summary: z.string().min(1).max(4_000), locationId: Id,
    presentCharacters: z.array(Id).max(20), perspective: z.enum(['offscreen','outcome']).optional(), precondition: GuardSchema,
  };
  const terminalEntry = z.object(sceneBase).strict();
  const actionEntry = z.object({ ...sceneBase, actions: z.array(ActionSchema).min(1).max(16) }).strict();
  const scenes = skeleton.scenes.map((scene) => {
    const result = (scene.endingId ? terminalEntry : actionEntry).safeParse(parsed.scenes[scene.key]);
    if (!result.success) throw new Error('Outcome-bound Plan Details 오류 (scenes.' + scene.key + '): ' + result.error.issues[0]!.message);
    return scene.endingId
      ? { ...result.data, key: scene.key, terminal: { condition: getEndingOutcome(outcomes, scene.endingId).condition } }
      : { ...result.data, key: scene.key };
  });
  return {
    details: parsed,
    compiled: parseNarrativeDetails({ initialState: outcomes.initialState, scenes }, approval, skeleton),
  };
}
