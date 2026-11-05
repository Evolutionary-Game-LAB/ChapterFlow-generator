export type GenerationGraph = { nodes: Array<{id:string; title:string}>; edges: Array<{from:string; to:string}> };
export type GenerationProgress = { stage:'seed'|'expansion'|'prose'|'review'|'patch'|'retry'; message:string; graph?:GenerationGraph; activeNodeIds?:string[]; reset?:boolean; chapter?:{completed:number;total:number;endingLabel:string} };
export type ProgressSink = (event:GenerationProgress)=>void;

/** NDJSON may split anywhere, including within a UTF-8 character. Never accept a truncated result. */
export async function readGenerationStream(response:Response, progress:ProgressSink, checkpoint?:(data:unknown)=>void):Promise<unknown> {
  if (!response.ok) throw new Error('그래프 생성을 시작하지 못했습니다.');
  if (!response.body) throw new Error('진행 응답이 없습니다.');
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=''; let result:unknown; let completed=false;
  const consume=(line:string)=>{if(!line.trim())return; const event=JSON.parse(line);
    if(event.type==='progress'&&!completed) progress(event.data);
    else if(event.type==='checkpoint'&&!completed) checkpoint?.(event.data);
    else if(event.type==='error') throw new Error(event.message||'생성에 실패했습니다.');
    else if(event.type==='result'){result=event.data;completed=true;}
  };
  try {while(true){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});let index:number;while((index=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(done)break;}if(buffer.trim())consume(buffer);if(!completed)throw new Error('연결이 끊겨 결과를 받지 못했습니다. 다시 시도해 주세요.');return result;}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
