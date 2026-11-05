import { z } from 'zod';
import type { AuthorContract } from './author-contract.js';

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const Text = z.string().min(1).max(200);

const SceneSchema = z.object({ key: Id, title: Text, endingId: Id.optional() }).strict();
const LinkSchema = z.object({ from: Id, to: Id, label: Text }).strict();

export const NarrativeSkeletonSchema = z.object({
  title: Text,
  scenes: z.array(SceneSchema).min(1).max(64),
  links: z.array(LinkSchema).max(256),
}).strict();

export type NarrativeSkeleton = z.infer<typeof NarrativeSkeletonSchema>;

const idJsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 } as const;
const textJsonSchema = { type: 'string', minLength: 1, maxLength: 200 } as const;

export const narrativeSkeletonJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'scenes', 'links'], properties: {
    title: textJsonSchema,
    scenes: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['key', 'title'], properties: { key: idJsonSchema, title: textJsonSchema, endingId: idJsonSchema } } },
    links: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'label'], properties: { from: idJsonSchema, to: idJsonSchema, label: textJsonSchema } } },
  },
} as const;

export function parseNarrativeSkeleton(raw: unknown, contract: AuthorContract): NarrativeSkeleton {
  const parsed = NarrativeSkeletonSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Narrative Skeleton 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const skeleton = parsed.data;
  const keys = new Set<string>();
  for (const [index, scene] of skeleton.scenes.entries()) {
    if (keys.has(scene.key)) throw new Error(`Narrative Skeleton 오류 (scenes.${index}.key): duplicate scene key '${scene.key}'`);
    keys.add(scene.key);
  }
  for (const [index, link] of skeleton.links.entries()) {
    if (!keys.has(link.from)) throw new Error(`Narrative Skeleton 오류 (links.${index}.from): unknown scene '${link.from}'`);
    if (!keys.has(link.to)) throw new Error(`Narrative Skeleton 오류 (links.${index}.to): unknown scene '${link.to}'`);
  }
  const endings = new Set(contract.endings.map((ending) => ending.id));
  for (const [index, scene] of skeleton.scenes.entries()) {
    if (scene.endingId && !endings.has(scene.endingId)) throw new Error(`Narrative Skeleton 오류 (scenes.${index}.endingId): unapproved endingId '${scene.endingId}'`);
  }
  if (skeleton.scenes[0]!.endingId) throw new Error('Narrative Skeleton 오류 (scenes.0): Start must be nonterminal');
  for (const [index, scene] of skeleton.scenes.entries()) {
    const outgoing = skeleton.links.some((link) => link.from === scene.key);
    if (scene.endingId && outgoing) throw new Error(`Narrative Skeleton 오류 (scenes.${index}): terminal scene has outgoing link`);
    if (!scene.endingId && !outgoing) throw new Error(`Narrative Skeleton 오류 (scenes.${index}): nonterminal scene needs an outgoing link`);
  }
  for (const endingId of endings) {
    const count = skeleton.scenes.filter((scene) => scene.endingId === endingId).length;
    if (count !== 1) throw new Error(`Narrative Skeleton 오류 (scenes): approved ending '${endingId}' must have exactly one terminal scene`);
  }
  return skeleton;
}
