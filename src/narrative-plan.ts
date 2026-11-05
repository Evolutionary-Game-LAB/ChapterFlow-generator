import { z } from 'zod';
import { StatefulStorylinePlanSchema } from './stateful-storyline-plan.js';
import { StorylinePlanSchema } from './storyline-plan.js';

const Text = z.string().min(1).max(200);
const BeatSchema = z.object({ title: Text }).strict();

const LegacyNarrativePlanSchema = z.object({
  title: Text,
  beats: z.array(BeatSchema).max(8),
}).strict();

export const NarrativePlanSchema = z.union([LegacyNarrativePlanSchema, StorylinePlanSchema, StatefulStorylinePlanSchema]);

export type NarrativePlan = z.infer<typeof NarrativePlanSchema>;

export const narrativePlanJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'beats'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    beats: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } } },
  },
} as const;

export function parseNarrativePlan(raw: unknown): NarrativePlan {
  const schema = raw && typeof raw === 'object' && 'format' in raw ? raw.format === 'stateful-storylines-v2' ? StatefulStorylinePlanSchema : StorylinePlanSchema : LegacyNarrativePlanSchema;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new Error(`Narrative Plan 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
}
