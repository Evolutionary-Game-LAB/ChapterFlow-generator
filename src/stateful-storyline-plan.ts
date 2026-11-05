import { z } from 'zod';
import { GuardSchema, EffectSchema, SYMBOLIC_ASSIGNMENT_LIMIT } from './symbolic-graph.js';

export const StatefulBeatSchema = z.object({
  key: z.string().regex(/^beat_[a-z0-9_]+$/).max(48),
  title: z.string().min(1).max(200),
  precondition: GuardSchema,
  effects: z.array(EffectSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT),
}).strict();
export const StatefulStorylinePlanSchema = z.object({
  format: z.literal('stateful-storylines-v2'),
  title: z.string().min(1).max(200),
  beats: z.array(StatefulBeatSchema).min(2).max(40),
  storylines: z.array(z.object({ endingId: z.string().min(1).max(80), steps: z.array(z.object({ beatKey: z.string().regex(/^beat_[a-z0-9_]+$/).max(48) }).strict()).min(2).max(20) }).strict()).min(1).max(12),
}).strict();
export type StatefulStorylinePlan = z.infer<typeof StatefulStorylinePlanSchema>;
