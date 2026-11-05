import { z } from 'zod';

const Text = z.string().min(1).max(200);
const BeatKey = z.string().regex(/^beat_[a-z0-9_]+$/).max(48);
export const StorylinePlanSchema = z.object({
  format: z.literal('storylines-v1'),
  title: Text,
  beats: z.array(z.object({ key: BeatKey, title: Text }).strict()).min(3).max(40),
  storylines: z.array(z.object({
    endingId: z.string().min(1).max(80),
    steps: z.array(z.object({ beatKey: BeatKey }).strict()).min(2).max(20),
  }).strict()).min(2).max(12),
}).strict();
export type StorylinePlan = z.infer<typeof StorylinePlanSchema>;

