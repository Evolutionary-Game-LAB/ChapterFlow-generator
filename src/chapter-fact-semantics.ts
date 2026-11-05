import {z} from 'zod';

/** Authoring metadata, not a new runtime value type. Old chapters may omit it. */
export const ChapterFactSemanticsSchema=z.object({
  scope:z.enum(['current','history']),
  failureMode:z.enum(['not_failure','failed_attempt','missed_opportunity','goal_failure']).optional(),
  reason:z.string().max(300),
}).strict();
export type ChapterFactSemantics=z.infer<typeof ChapterFactSemanticsSchema>;
export const ChapterInitialEvidenceSchema=z.object({
  basis:z.enum(['source','unestablished_history','authored_default']),
  quote:z.string().max(1200),
  reason:z.string().max(500),
}).strict();
