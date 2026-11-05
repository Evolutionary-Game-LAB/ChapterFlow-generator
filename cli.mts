import fs from 'node:fs';
import {ChapterRequestSchema,generateChapter,chapterBudgetMs} from './server/chapter-generation.js';
import {postJsonSafe} from './server/safe-http.js';
import {serializeStory} from './src/import-export/story-json.js';
process.env.CHAPTER_DECISION_DISABLE='1';
const args=process.argv.slice(2),validate=args.includes('--validate-only');
const files=args.filter(a=>!a.startsWith('--'));
if(!files[0]||(!validate&&!files[1]))throw Error('Usage: npm run generate -- request.json story.json [--validate-only]');
const raw=JSON.parse(fs.readFileSync(files[0],'utf8'));
if(raw.settings?.apiKey)throw Error('Do not put API keys in request files. Use LLM_API_KEY environment variable.');
const input=ChapterRequestSchema.parse({...raw,settings:{...raw.settings,apiKey:process.env.LLM_API_KEY??''}});
if(input.operation!=='create'||input.settings.mode!=='openai-compatible')throw Error('Public CLI supports API chapter creation only.');
if(validate){console.log('Request schema valid. No API request sent.');process.exit(0);}
if(!input.settings.apiKey)throw Error('Set LLM_API_KEY. It is never written to output.');
if(fs.existsSync(files[1]))throw Error('Output exists; choose another path.');
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),chapterBudgetMs('create'));
process.once('SIGINT',()=>controller.abort());
try{
 const result=await generateChapter(input,postJsonSafe,()=>{},()=>{},controller.signal,()=>{});
 fs.writeFileSync(files[1],serializeStory(result.story),{flag:'wx'});
 console.log('Chapter written.');
}catch{process.exitCode=1;console.error('Chapter generation failed or was cancelled. No output was overwritten.');}
finally{clearTimeout(timer);}
