import {z} from 'zod';
import {AtomRefSchema, AtomValueSchema, ComparisonSchema} from './symbolic-graph.js';
import {AddedChapterSymbolSchema,ChapterGameplaySchema, type ChapterGameplay} from './chapter-gameplay.js';
import {symbolicAtomKey} from './playtest/symbolic-engine.js';

export const GameplayEditSchema=z.object({
  ref:AtomRefSchema,from:AtomValueSchema.shape.value,to:AtomValueSchema.shape.value,both:z.boolean(),
  conditions:z.array(z.array(ComparisonSchema).max(72)).min(1).max(256),
}).strict().refine(v=>typeof v.from===typeof v.to,'변화 전후의 값 형식이 다릅니다.').refine(v=>v.from!==v.to,'변화 전후 값은 달라야 합니다.');
export const EventEditSchema=z.object({
  summary:z.string().trim().min(1).max(4000).optional(),
  entry:z.array(z.array(ComparisonSchema).max(72)).min(1).max(256).optional(),
  gameplay:z.record(GameplayEditSchema.nullable()).optional(),
}).strict();
export const ChapterEditsSchema=z.object({events:z.record(EventEditSchema),symbols:z.array(AddedChapterSymbolSchema).max(80).optional()}).strict();
export type ChapterEdits=z.infer<typeof ChapterEditsSchema>;
export type EventEdit=z.infer<typeof EventEditSchema>;
export type GameplayEdit=z.infer<typeof GameplayEditSchema>;

/** Generated witnesses remain untouched. Explicit user edits are an overlay on
 * integration rules, validated independently and included in saved JSON. */
export function applyChapterEdits(base:ChapterGameplay,raw?:ChapterEdits):ChapterGameplay{
  if(!raw)return base;
  const edits=ChapterEditsSchema.parse(raw),chapter=structuredClone(base);
  const atoms=new Map(base.initialState.map(a=>[symbolicAtomKey(a.ref),a.value]));
  const ids=new Set(base.initialState.map(a=>a.ref.symbol)),names=new Set<string>();
  for(const symbol of edits.symbols??[]){
    if(ids.has(symbol.ref.symbol)||names.has(symbol.name.normalize('NFKC').toLocaleLowerCase()))throw new Error('중복된 심볼입니다.');
    ids.add(symbol.ref.symbol);names.add(symbol.name.normalize('NFKC').toLocaleLowerCase());
    atoms.set(symbolicAtomKey(symbol.ref),symbol.initial);
    chapter.initialState.push({ref:symbol.ref,value:symbol.initial});
  }
  if(edits.symbols?.length)chapter.addedSymbols=structuredClone(edits.symbols);
  const check=(c:{ref:z.infer<typeof AtomRefSchema>;value:boolean|number})=>{
    const value=atoms.get(symbolicAtomKey(c.ref));
    if(value===undefined||typeof value!==typeof c.value)throw new Error('편집 규칙에 존재하지 않거나 형식이 다른 심볼이 있습니다.');
  };
  for(const [id,edit] of Object.entries(edits.events)){
    const event=chapter.events.find(e=>e.id===id);
    if(!event)throw new Error('수정한 사건이 원본에 없습니다: '+id);
    if(edit.entry){
      edit.entry.flat().forEach(check);
      event.entryAlternatives=edit.entry.map(all=>({all}));event.entryCondition={all:[]};
      // Entry conditions are authored at the destination. Do not leave the old
      // destination predicate hidden in the incoming completion signal.
      for(const source of chapter.events)for(const exit of source.exits.filter(e=>e.to===id)){
        const old=new Set(exit.condition.all.map(c=>JSON.stringify(c)));
        const signal=source.signals.find(s=>s.id===exit.requiredSignal);
        if(signal)signal.condition.all=signal.condition.all.filter(c=>!old.has(JSON.stringify(c))||signal.effects.some(e=>symbolicAtomKey(e.ref)===symbolicAtomKey(c.ref)));
        exit.condition={all:[]};
      }
    }
  }
  for(const [id,edit] of Object.entries(edits.events)){
    const event=chapter.events.find(e=>e.id===id)!;
    const editedKeys=new Set(Object.keys(edit.gameplay??{}));
    for(const key of editedKeys)if(!atoms.has(key))throw new Error('편집 대상 심볼이 원본에 없습니다.');
    // Remove original assignments first, so a later removal cannot erase a
    // replacement that now refers to that symbol.
    for(const signal of event.signals){
      signal.effects=signal.effects.filter(e=>!editedKeys.has(symbolicAtomKey(e.ref)));
      signal.condition.all=signal.condition.all.filter(c=>!editedKeys.has(symbolicAtomKey(c.ref)));
    }
    for(const [key,replacement] of Object.entries(edit.gameplay??{})){
      if(!replacement)continue;
      check({ref:replacement.ref,value:replacement.from});check({ref:replacement.ref,value:replacement.to});replacement.conditions.flat().forEach(check);
      const refKey=symbolicAtomKey(replacement.ref);
      const symbol=edits.symbols?.find(s=>symbolicAtomKey(s.ref)===refKey);
      if(symbol?.changeMode==='irreversible'&&replacement.both)throw new Error('되돌림 불가 심볼은 양방향으로 변경할 수 없습니다.');
      const values=replacement.both?[[replacement.from,replacement.to],[replacement.to,replacement.from]]:[[replacement.from,replacement.to]];
      const display=(v:boolean|number)=>typeof v==='boolean'?(v?'예':'아니오'):v.toFixed(2);
      for(const [from,value] of values)for(const [i,group] of replacement.conditions.entries()){
        event.signals.push({id:`edit:${id}:${encodeURIComponent(key)}:${value}:${i}`,label:`심볼 변경 · ${symbol?.name??replacement.ref.symbol} ${display(from!)} → ${display(value!)}`,
          condition:{all:[...group.filter(c=>![key,refKey].includes(symbolicAtomKey(c.ref))),{ref:replacement.ref,op:'eq',value:from!}]},
          effects:[{ref:replacement.ref,op:'set',value:value!}],oncePerVisit:false});
      }
    }
  }
  return ChapterGameplaySchema.parse(chapter);
}
