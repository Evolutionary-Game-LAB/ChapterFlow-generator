import type { StatefulStorylinePlan } from './stateful-storyline-plan.js';
import type { AuthorContractApproval } from './author-contract.js';
import { parseNarrativePlan } from './narrative-plan.js';
import type { StorylinePlan } from './storyline-plan.js';
import { parseNarrativeSkeleton } from './narrative-skeleton.js';

export function compileNarrativePlan(approval: AuthorContractApproval, raw: unknown) {
  const plan = parseNarrativePlan(raw);
  if ('format' in plan) return compileStorylines(approval, plan);
  const beats = plan.beats.map((beat, index) => ({ key: `beat_${index + 1}`, title: beat.title }));
  const endings = approval.contract.endings.map((ending) => ({ key: `end_${ending.id}`, title: ending.label, endingId: ending.id }));
  const prefix = [{ key: 'start', title: '시작' }, ...beats];
  // Retained for legacy plan-details requests and previously saved plans.
  return parseNarrativeSkeleton({
    title: plan.title,
    scenes: [...prefix, ...endings],
    links: [
      ...prefix.slice(0, -1).map((scene, index) => ({ from: scene.key, to: prefix[index + 1]!.key, label: '계속' })),
      ...endings.map((ending) => ({ from: prefix.at(-1)!.key, to: ending.key, label: ending.title })),
    ],
  }, approval.contract);
}

export type CompiledNarrativePlan = ReturnType<typeof compileNarrativePlan>;

function compileStorylines(approval: AuthorContractApproval, plan: StorylinePlan | StatefulStorylinePlan) {
  const fail = (reason: string): never => { throw new Error('Narrative Plan 오류 (storylines): ' + reason); };
  const beatKeys = new Set(plan.beats.map((beat) => beat.key));
  const beatTitles = new Map(plan.beats.map((beat) => [beat.key, beat.title]));
  if (beatKeys.size !== plan.beats.length) fail('duplicate beat key');
  const endings = new Map(approval.contract.endings.map((ending) => [ending.id, ending]));
  const seenBeats = new Set<string>();
  const seenEndings = new Set<string>();
  const edges = new Map<string, { from: string; to: string; label: string }>();
  const opening = plan.storylines[0]!.steps[0]!.beatKey;
  const addEdge = (from: string, to: string, label: string) => {
    const key = from + ':' + to;
    edges.set(key, { from, to, label });
  };
  for (const [index, line] of plan.storylines.entries()) {
    if (!endings.has(line.endingId)) fail('unapproved ending: ' + line.endingId);
    if (line.steps[0]!.beatKey !== opening) fail('storylines must share the opening beat');
    const keys = line.steps.map((step) => step.beatKey);
    if (new Set(keys).size !== keys.length) fail('a storyline repeats a beat');
    if (keys.some((key) => !beatKeys.has(key))) fail('unknown beat reference');
    // Stateful graphs can add a meaningful connection between existing scenes
    // (for example, recovering into another established continuation). Requiring
    // a fresh node here forced filler scenes and rejected valid shared paths.
    // A shared outcome scene may confirm different endings according to prior
    // state. A genuinely new terminal edge is valid too; the runtime must prove
    // its declared route. The graph-wide nonterminal-choice check below still
    // rejects stories whose only choice is an ending menu. Exact duplicates add no edge.
    const newIntermediateLink = keys.slice(1).some((to, i) => !edges.has(keys[i]! + ':' + to));
    const newTerminalLink = !edges.has(keys.at(-1)!+':end_'+line.endingId);
    if (index && !keys.some((key) => !seenBeats.has(key)) && !(plan.format === 'stateful-storylines-v2' && (newIntermediateLink||newTerminalLink))) fail('each alternative must add a new intermediate beat or stateful connection');
    let from = 'start';
    for (const step of line.steps) {
      addEdge(from, step.beatKey, beatTitles.get(step.beatKey)!);
      seenBeats.add(step.beatKey);
      from = step.beatKey;
    }
    addEdge(from, 'end_' + line.endingId, endings.get(line.endingId)!.label);
    seenEndings.add(line.endingId);
  }
  if (seenBeats.size !== beatKeys.size) fail('unused beat');
  if (seenEndings.size !== endings.size) fail('every approved ending must have a storyline');
  const links = [...edges.values()];
  const children = (key: string) => links.filter((link) => link.from === key).map((link) => link.to);
  if ((plan.format === 'storylines-v1' || plan.storylines.length > 1) && ![...beatKeys].some((key) => children(key).filter((to) => beatKeys.has(to)).length >= 2)) fail('need a choice between nonterminal beats, not only endings');
  for (const key of beatKeys) {
    const labels = links.filter((link) => link.from === key).map((link) => link.label);
    if (new Set(labels).size !== labels.length) fail('choice labels must be distinct at ' + key);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) fail('merging storylines creates a cycle');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const child of children(key)) visit(child);
    visiting.delete(key); visited.add(key);
  };
  visit('start');
  if (plan.format === 'storylines-v1' && ![...beatKeys].some((key) => links.filter((link) => link.to === key).length >= 2)) fail('need a shared intermediate reconvergence after divergence');
  return parseNarrativeSkeleton({
    title: plan.title,
    scenes: [{ key: 'start', title: '시작' }, ...plan.beats.map(({ key, title }) => ({ key, title })), ...approval.contract.endings.map((ending) => ({ key: 'end_' + ending.id, title: ending.label, endingId: ending.id }))],
    links,
  }, approval.contract);
}
