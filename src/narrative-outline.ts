import {SYMBOLIC_ASSIGNMENT_LIMIT} from './symbolic-graph.js';
import { z } from 'zod';
import type { AuthorContract } from './author-contract.js';
import { AtomValueSchema, EffectSchema, GuardSchema } from './symbolic-graph.js';

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const SceneBase = {
  key: Id,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4_000),
  locationId: Id,
  presentCharacters: z.array(Id).max(20),
  precondition: GuardSchema,
};
const ActionSchema = z.object({ label: z.string().min(1).max(200), to: Id, precondition: GuardSchema, effects: z.array(EffectSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT) }).strict();
const TerminalSceneSchema = z.object({ ...SceneBase, terminal: z.object({ endingId: Id, condition: GuardSchema }).strict() }).strict();
const ActionSceneSchema = z.object({ ...SceneBase, actions: z.array(ActionSchema).min(1).max(16) }).strict();

export const NarrativeOutlineSchema = z.object({
  title: z.string().min(1).max(200),
  initialState: z.array(AtomValueSchema).max(256),
  scenes: z.array(z.union([TerminalSceneSchema, ActionSceneSchema])).min(1).max(64),
}).strict();

export type NarrativeOutline = z.infer<typeof NarrativeOutlineSchema>;

const idJsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 } as const;
const numberJsonSchema = { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.01 } as const;
const atomRefJsonSchema = { type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: { symbol: idJsonSchema, args: { type: 'array', maxItems: 2, items: idJsonSchema } } } as const;
const guardJsonSchema = { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRefJsonSchema, op: { enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] }, value: { anyOf: [{ type: 'boolean' }, numberJsonSchema] } } } } } } as const;
const effectJsonSchema = { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRefJsonSchema, op: { enum: ['set', 'add'] }, value: { anyOf: [{ type: 'boolean' }, { type: 'number', minimum: -1, maximum: 1, multipleOf: 0.01 }] } } } as const;
const sceneBaseJsonSchema = { key: idJsonSchema, title: { type: 'string', minLength: 1, maxLength: 200 }, summary: { type: 'string', minLength: 1, maxLength: 4_000 }, locationId: idJsonSchema, presentCharacters: { type: 'array', maxItems: 20, items: idJsonSchema }, precondition: guardJsonSchema } as const;

export const narrativeOutlineJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'initialState', 'scenes'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    initialState: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['ref', 'value'], properties: { ref: atomRefJsonSchema, value: { anyOf: [{ type: 'boolean' }, numberJsonSchema] } } } },
    scenes: { type: 'array', minItems: 1, maxItems: 64, items: { anyOf: [
      { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBaseJsonSchema), 'actions'], properties: { ...sceneBaseJsonSchema, actions: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['label', 'to', 'precondition', 'effects'], properties: { label: { type: 'string', minLength: 1, maxLength: 200 }, to: idJsonSchema, precondition: guardJsonSchema, effects: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: effectJsonSchema } } } } } },
      { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBaseJsonSchema), 'terminal'], properties: { ...sceneBaseJsonSchema, terminal: { type: 'object', additionalProperties: false, required: ['endingId', 'condition'], properties: { endingId: idJsonSchema, condition: guardJsonSchema } } } },
    ] } },
  },
} as const;

export type NarrativeOutlineJsonSchema = Record<string, any>;

const noMatchJsonSchema = { type: 'string', minLength: 1, maxLength: 0 } as const;
const enumOrNoMatch = (values: string[]) => values.length ? { enum: values } : noMatchJsonSchema;
const oneOfOrNoMatch = (schemas: NarrativeOutlineJsonSchema[]) => schemas.length ? { oneOf: schemas } : noMatchJsonSchema;
const numericValueJsonSchema = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum, multipleOf: 0.01 });

export function narrativeOutlineJsonSchemaForContract(contract: AuthorContract): NarrativeOutlineJsonSchema {
  const entities = [...contract.entities.characters, ...contract.entities.items, ...contract.entities.locations];
  const locations = enumOrNoMatch(contract.entities.locations);
  const characters = enumOrNoMatch(contract.entities.characters);
  const endings = enumOrNoMatch(contract.endings.map((ending) => ending.id));
  const atomRef = (symbol: AuthorContract['stateSymbols'][number] | AuthorContract['relationshipSymbols'][number]) => ({
    type: 'object', additionalProperties: false, required: ['symbol', 'args'], properties: {
      symbol: { const: symbol.id },
      args: { type: 'array', minItems: symbol.parameterCount, maxItems: symbol.parameterCount, items: enumOrNoMatch(entities) },
    },
  });
  const symbols = [...contract.stateSymbols, ...contract.relationshipSymbols];
  const valueSchema = (symbol: typeof symbols[number]) => {
    if (symbol.type === 'boolean') return { type: 'boolean' };
    const [minimum, maximum] = 'range' in symbol && symbol.range ? symbol.range : [0, 1];
    return numericValueJsonSchema(minimum, maximum);
  };
  const initialItem = oneOfOrNoMatch(symbols.map((symbol) => ({
    type: 'object', additionalProperties: false, required: ['ref', 'value'], properties: { ref: atomRef(symbol), value: valueSchema(symbol) },
  })));
  const comparisonItem = oneOfOrNoMatch(symbols.map((symbol) => ({
    type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: {
      ref: atomRef(symbol), op: { enum: symbol.type === 'boolean' ? ['eq', 'ne'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] }, value: valueSchema(symbol),
    },
  })));
  const effectItem = oneOfOrNoMatch(symbols.map((symbol) => {
    if (symbol.type === 'boolean') return { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: { type: 'boolean' } } };
    const [minimum, maximum] = 'range' in symbol && symbol.range ? symbol.range : [0, 1];
    return { oneOf: [
      { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'set' }, value: numericValueJsonSchema(minimum, maximum) } },
      { type: 'object', additionalProperties: false, required: ['ref', 'op', 'value'], properties: { ref: atomRef(symbol), op: { const: 'add' }, value: numericValueJsonSchema(-1, 1) } },
    ] };
  }));
  const guard = { type: 'object', additionalProperties: false, required: ['all'], properties: { all: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: comparisonItem } } };
  const sceneBase = { key: idJsonSchema, title: { type: 'string', minLength: 1, maxLength: 200 }, summary: { type: 'string', minLength: 1, maxLength: 4_000 }, locationId: locations, presentCharacters: { type: 'array', maxItems: 20, items: characters }, precondition: guard };
  return {
    type: 'object', additionalProperties: false, required: ['title', 'initialState', 'scenes'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, initialState: { type: 'array', maxItems: 256, items: initialItem },
      scenes: { type: 'array', minItems: 1, maxItems: 64, items: { anyOf: [
        { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBase), 'actions'], properties: { ...sceneBase, actions: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['label', 'to', 'precondition', 'effects'], properties: { label: { type: 'string', minLength: 1, maxLength: 200 }, to: idJsonSchema, precondition: guard, effects: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: effectItem } } } } } },
        { type: 'object', additionalProperties: false, required: [...Object.keys(sceneBase), 'terminal'], properties: { ...sceneBase, terminal: { type: 'object', additionalProperties: false, required: ['endingId', 'condition'], properties: { endingId: endings, condition: guard } } } },
      ] } },
    },
  };
}

export function parseNarrativeOutline(raw: unknown): NarrativeOutline {
  const parsed = NarrativeOutlineSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Narrative Outline 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const keys = new Set<string>();
  for (const scene of parsed.data.scenes) {
    if (keys.has(scene.key)) throw new Error(`Narrative Outline 오류 (scenes): duplicate scene key '${scene.key}'`);
    keys.add(scene.key);
  }
  for (const scene of parsed.data.scenes) if ('actions' in scene) for (const action of scene.actions) {
    if (!keys.has(action.to)) throw new Error(`Narrative Outline 오류 (scenes.${scene.key}.actions): unknown target scene '${action.to}'`);
  }
  return parsed.data;
}
