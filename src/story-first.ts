import {z} from 'zod';
import {SYMBOLIC_ASSIGNMENT_LIMIT} from './symbolic-graph.js';

/** Authoring evidence retained in exports; no provider credentials or UI settings. */
export const ManuscriptSchema=z.object({
  title:z.string().min(1).max(200),
  truth:z.string().min(1).max(1800),
  motives:z.array(z.object({character:z.string().min(1).max(100),goal:z.string().min(1).max(600),changeReason:z.string().min(1).max(600)}).strict()).max(8),
  opening:z.string().min(1).max(1800),
  causalLinks:z.array(z.object({action:z.string().min(1).max(500),consequence:z.string().min(1).max(500),laterImpact:z.string().min(1).max(500)}).strict()).max(12).optional(),
  places:z.array(z.object({name:z.string().min(1).max(100),within:z.string().min(1).max(100).nullable()}).strict()).max(12).optional(),
  paths:z.array(z.object({ending:z.string().min(1).max(200),story:z.string().min(1).max(3500)}).strict()).min(1).max(6),
  opportunities:z.array(z.object({situation:z.string().min(1).max(500),alternatives:z.array(z.string().min(1).max(700)).min(2).max(3),commonContinuation:z.string().min(1).max(500)}).strict()).min(0).max(4).optional(),
  branches:z.array(z.object({id:z.string(),ending:z.string(),fromEventId:z.string(),rejoinEventId:z.string(),story:z.string().min(1).max(5000),passage:z.string().min(1).max(2000)}).strict()).max(8).optional(),
}).strict();
export type Manuscript=z.infer<typeof ManuscriptSchema>;
export const EventAuthoringSchema=z.object({
  version:z.literal('story-first-v1'),
  execution:z.literal('source-owned-v1').optional(),
  guardUnchangedEntries:z.literal(true).optional(),
  terminalConfirmations:z.literal(true).optional(),
  actions:z.array(z.object({from:z.string(),to:z.string(),label:z.string().min(1).max(240),description:z.string().min(1).max(2600),mode:z.enum(['result','choice']),when:z.array(z.object({fact:z.string(),value:z.boolean()}).strict()).max(SYMBOLIC_ASSIGNMENT_LIMIT).optional()}).strict()).max(120),
  entries:z.array(z.object({eventId:z.string(),conditions:z.array(z.object({fact:z.string(),value:z.boolean()}).strict()).max(SYMBOLIC_ASSIGNMENT_LIMIT)}).strict()).max(40).optional(),
}).strict();
export type EventAuthoring=z.infer<typeof EventAuthoringSchema>;
