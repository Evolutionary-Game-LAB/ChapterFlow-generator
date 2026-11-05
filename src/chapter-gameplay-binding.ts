import {parseSymbolicStoryPayload,type SymbolicStoryPayload} from './symbolic-story-payload.js';
import {compileAuthoredChapterGameplay} from './chapter-gameplay-compiler.js';
import type {ChapterGameplay} from './chapter-gameplay.js';
import type {ChapterEdits} from './chapter-edits.js';
/** Parse and validate the original rules before applying separately retained user edits. */
export function buildChapterGameplay(raw:SymbolicStoryPayload,existing?:ChapterGameplay,edits?:ChapterEdits,policy?:ChapterGameplay['branchPolicy']):ChapterGameplay{
  return compileAuthoredChapterGameplay(parseSymbolicStoryPayload(raw),existing,edits,policy);
}
