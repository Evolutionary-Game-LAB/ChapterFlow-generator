/** Joint-story is the web API creation default; older pipelines remain selectable internally. */
import {generateChapter as generateLegacy,ChapterRequestSchema} from './chapter-generation-legacy.js';
import {generateStoryFirstWithRecovery} from './story-first-recovery.js';
import {generateJointStory} from './joint-story-generation.js';
export {ChapterRequestSchema,chapterBudgetMs,chapterEnrichmentBudgetMs,assertChapterComplete,assertChapterPreserved,verifyPlannedChapterEndings,chapterRetryDiagnostic} from './chapter-generation-legacy.js';
export type {ChapterCheckpoint} from './chapter-generation-legacy.js';
export const generateChapter:typeof generateLegacy=(raw,...args)=>{
  const input=ChapterRequestSchema.parse(raw);
  const apiCreate=input.operation==='create'&&input.settings.mode==='openai-compatible';
  const pipeline=process.env.CHAPTER_PIPELINE;
  if(apiCreate&&pipeline!=='legacy'&&pipeline!=='story-first')return generateJointStory(raw,...args);
  const storyFirst=apiCreate&&pipeline==='story-first';
  args[2]?.({type:'chapter-pipeline-selected',pipeline:storyFirst?'story-first':'legacy',operation:input.operation});
  return storyFirst?generateStoryFirstWithRecovery(raw,...args):generateLegacy(raw,...args);
};
