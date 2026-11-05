import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const idJsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 } as const;

const SymbolSchema = z.object({
  id: Id,
  meaning: z.string().min(1).max(500).optional(),
  type: z.enum(['boolean', 'number']),
  parameterCount: z.literal(1),
}).strict();

const RelationshipSymbolSchema = z.object({
  id: Id,
  meaning: z.string().min(1).max(500).optional(),
  type: z.enum(['boolean', 'number']),
  parameterCount: z.literal(2),
  directed: z.literal(true),
  range: z.tuple([z.literal(0), z.literal(1)]).optional(),
}).strict();

export const AuthorContractSchema = z.object({
  entityLabels: z.array(z.object({id:Id,label:z.string().trim().min(1).max(200)}).strict()).max(100).optional(),
  entities: z.object({
    characters: z.array(Id).min(1).max(20),
    items: z.array(Id).max(40),
    locations: z.array(Id).min(1).max(40),
  }).strict(),
  stateSymbols: z.array(SymbolSchema).max(40),
  relationshipSymbols: z.array(RelationshipSymbolSchema).max(40),
  endings: z.array(z.object({ id: Id, label: z.string().min(1).max(200) }).strict()).min(1).max(6),
}).strict();

export type AuthorContract = z.infer<typeof AuthorContractSchema>;

export type AuthorContractApproval = Readonly<{
  brief: string;
  contract: AuthorContract;
  playerId: string;
  revision: string;
}>;

type SymbolKind = 'stateSymbols' | 'relationshipSymbols';
type SymbolUpdate = { id?: string; type?: 'boolean' | 'number' };

export function updateContractSymbol(contract: AuthorContract, kind: SymbolKind, index: number, update: SymbolUpdate): AuthorContract {
  const symbols = contract[kind].map((symbol, position) => {
    if (position !== index) return symbol;
    const type = update.type ?? symbol.type;
    if (kind === 'relationshipSymbols') {
      return { ...symbol, ...update, type, range: type === 'number' ? [0, 1] as [0, 1] : undefined };
    }
    return { ...symbol, ...update, type };
  });
  return { ...contract, [kind]: symbols } as AuthorContract;
}

export function approveAuthorContract(brief: string, contract: AuthorContract, playerId: string, revision: string): AuthorContractApproval {
  const parsed = parseAuthorContract(contract);
  if (!parsed.entities.characters.includes(playerId)) throw new Error('Author Contract 오류 (playerId): 인물 entity여야 합니다.');
  return Object.freeze({ brief: brief.trim(), contract: structuredClone(parsed), playerId, revision });
}

export const authorContractJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['entities', 'stateSymbols', 'relationshipSymbols', 'endings', 'entityLabels'],
  properties: {
    entityLabels: { type: 'array', minItems: 2, maxItems: 100, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: idJsonSchema, label: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } } } },
    entities: { type: 'object', additionalProperties: false, required: ['characters', 'items', 'locations'], properties: {
      characters: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: idJsonSchema },
      items: { type: 'array', maxItems: 40, uniqueItems: true, items: idJsonSchema },
      locations: { type: 'array', minItems: 1, maxItems: 40, uniqueItems: true, items: idJsonSchema },
    } },
    stateSymbols: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['id', 'meaning', 'type', 'parameterCount'], properties: { id: idJsonSchema, meaning: { type: 'string', minLength: 1, maxLength: 500 }, type: { enum: ['boolean', 'number'] }, parameterCount: { const: 1 } } } },
    relationshipSymbols: { type: 'array', maxItems: 40, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['id', 'meaning', 'type', 'parameterCount', 'directed'], properties: { id: idJsonSchema, meaning: { type: 'string', minLength: 1, maxLength: 500 }, type: { enum: ['boolean', 'number'] }, parameterCount: { const: 2 }, directed: { const: true }, range: { type: 'array', prefixItems: [{ const: 0 }, { const: 1 }], minItems: 2, maxItems: 2 } } } },
    endings: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: idJsonSchema, label: { type: 'string', minLength: 1, maxLength: 200 } } } },
  },
} as const;

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

export function parseAuthorContract(raw: unknown): AuthorContract {
  const parsed = AuthorContractSchema.safeParse(raw);
  if (parsed.success) {
    const entityIds = Object.values(parsed.data.entities).flat();
    const duplicates = duplicateIds([
      ...entityIds,
      ...parsed.data.stateSymbols.map((symbol) => symbol.id),
      ...parsed.data.relationshipSymbols.map((symbol) => symbol.id),
    ]);
    if (duplicates.length) throw new Error(`Author Contract 오류: entity 또는 symbol ID가 중복됩니다: ${duplicates.join(', ')}`);
    const duplicateEndings = duplicateIds(parsed.data.endings.map((ending) => ending.id));
    if (duplicateEndings.length) throw new Error(`Author Contract 오류: ending ID가 중복됩니다: ${duplicateEndings.join(', ')}`);
    const labels = parsed.data.entityLabels;
    if (labels) {
      const declared = new Set(entityIds);
      const labelled = new Set(labels.map((label) => label.id));
      const missing = entityIds.filter((id) => !labelled.has(id));
      const unknown = [...labelled].filter((id) => !declared.has(id));
      const duplicateLabels = duplicateIds(labels.map((label) => label.id));
      if (missing.length || unknown.length || duplicateLabels.length) {
        throw new Error(`인물·장소·아이템 표시 이름이 선언된 대상과 일치하지 않습니다. 누락: [${missing.join(', ')}], 미선언: [${unknown.join(', ')}], 중복: [${duplicateLabels.join(', ')}]`);
      }
    }
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  throw new Error(`Author Contract 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
}
