import { z } from 'zod';
import type { AuthorContract } from './author-contract.js';
import type { EndingOutcome } from './ending-outcomes.js';

export const OutcomeRationaleSchema = z.object({ endingId: z.string(), explanation: z.string().trim().min(1).max(1200) }).strict();
export type OutcomeRationale = z.infer<typeof OutcomeRationaleSchema>;
export function parseOutcomeRationales(raw: unknown, contract: AuthorContract): OutcomeRationale[] {
  if (raw === undefined) return []; // Legacy proposal responses remain readable.
  const entries = z.array(OutcomeRationaleSchema).length(contract.endings.length).parse(raw);
  if (new Set(entries.map((entry) => entry.endingId)).size !== entries.length || entries.some((entry) => !contract.endings.some((e) => e.id === entry.endingId))) throw new Error('Ending outcome rationales must cover exactly the approved endings');
  return entries;
}
/** Each ending needs a state where it alone holds. Partial overlap is allowed; graph verification checks actual reachable terminals. */
export function assertDistinctOutcomeRegions(outcomes: readonly EndingOutcome[]) {
  const key = (ref: {symbol:string;args:string[]}) => JSON.stringify([ref.symbol,...ref.args]);
  for (const target of outcomes) {
    const fixed = new Map(target.condition.all.map((c)=>[key(c.ref),c.value]));
    const others = outcomes.filter((o)=>o!==target);
    const satisfy = (index:number, excluded:Map<string,Set<boolean|number>>):boolean => {
      if(index===others.length)return true;
      const clause=others[index]!.condition.all;
      if(clause.some((c)=>fixed.has(key(c.ref)) ? fixed.get(key(c.ref))!==c.value : excluded.get(key(c.ref))?.has(c.value))) return satisfy(index+1,excluded);
      for(const c of clause) {
        const atom=key(c.ref);
        if(fixed.has(atom))continue;
        const nextValues=new Set(excluded.get(atom));nextValues.add(c.value);
        if(typeof c.value==='boolean' && nextValues.has(true) && nextValues.has(false))continue;
        const next=new Map(excluded);next.set(atom,nextValues);
        if(satisfy(index+1,next))return true;
      }
      return false;
    };
    if(!satisfy(0,new Map()))throw new Error('Ending outcome conditions overlap so that '+target.endingId+' has no exclusive satisfying state. Clarify the actual narrative distinction.');
  }
}
export const outcomeMeaningPrompt = 'Define MINIMAL final narrative facts that directly express each ending label. Distinguish final outcomes from enabling conditions of earlier actions. Do not require possession of a key, low suspicion, trust, or an arbitrary numeric threshold merely because it may help a route. If the brief says the player does not learn the truth, use the truth-knowledge symbol; having a key does not imply knowing the truth. Represent source of knowledge and forgiveness separately when requested. Do not substitute generic knows(player,npc) or trusts for a more precise approved outcome symbol. Every ending must have some state where it alone holds, using actual narrative distinctions. Do not add irrelevant facts just to make every possible state mutually exclusive. Only use approved symbols; if they cannot express the ending, do not invent proxy conditions. Include initial values for useful action/resource atoms too, even if they are not ending conditions. Add rationales:[{endingId,explanation}] in the language of the brief, explaining how EACH condition follows from that ending, and which facts are intentionally irrelevant. These are proposals for human review, not a semantic correctness guarantee.';
