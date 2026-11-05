import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {ChoiceRow,ChoiceMode} from './semantic-choice.js';

/** Opt-in local research worker. No shell, network listener, or automatic product activation. */
export class SemIfProcess {
  private child:ChildProcessWithoutNullStreams;
  private pending=new Map<string,{resolve:(x:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private buffer='';private closed=false;
  private deadlineMs:number;private deadlineTimer:ReturnType<typeof setTimeout>;
  constructor(options:{python:string;script:string;deadline:string;modelPath:string;revision:string;maxTokens?:number;onStderr?:(text:string)=>void;extraEnv?:Record<string,string>}){
    if(!Number.isFinite(Date.parse(options.deadline))||Date.parse(options.deadline)<=Date.now())throw Error('Future deadline required');
    this.deadlineMs=Date.parse(options.deadline);
    this.child=spawn(options.python,['-u',options.script,'--model',options.modelPath,'--revision',options.revision,'--deadline',options.deadline,'--max-tokens',String(options.maxTokens??4096)],{shell:false,windowsHide:true,stdio:'pipe',env:{...process.env,...options.extraEnv,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});
    this.deadlineTimer=setTimeout(()=>this.close(new Error('SemIf deadline reached')),this.deadlineMs-Date.now());
    this.deadlineTimer.unref();
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdin.on('error',error=>this.close(error));
    this.child.stderr.on('data',data=>options.onStderr?.(String(data)));
    this.child.on('error',error=>this.close(error));
    this.child.on('exit',(code,signal)=>this.close(new Error(`SemIf worker exited: ${code}/${signal}`),false));
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      if(Buffer.byteLength(this.buffer)>8*1024*1024){this.close(new Error('SemIf response exceeded transport limit'));return;}
      let end:number;
      while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
        if(!line.trim())continue;
        try{const result=JSON.parse(line),pending=this.pending.get(result.id);if(!pending)throw Error('Unexpected SemIf response ID');
          this.pending.delete(result.id);clearTimeout(pending.timer);
          if(result.error)pending.reject(new Error(String(result.error)));else if(!Array.isArray(result.results))pending.reject(new Error('Malformed SemIf response'));else pending.resolve(result.results);
        }catch(error){this.close(error instanceof Error?error:new Error(String(error)));return;}
      }
    });
  }
  score(rows:ChoiceRow[],mode:ChoiceMode,timeoutMs=120000):Promise<unknown>{
    if(this.closed)return Promise.reject(new Error('SemIf worker closed'));
    if(this.pending.size)return Promise.reject(new Error('Concurrent SemIf calls are unsupported'));
    if(!Number.isFinite(timeoutMs)||timeoutMs<1)return Promise.reject(new Error('Invalid timeout'));
    const budget=Math.min(timeoutMs,this.deadlineMs-Date.now());
    if(budget<=0){this.close(new Error('SemIf deadline reached'));return Promise.reject(new Error('SemIf deadline reached'));}
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(new Error('SemIf request timeout')),budget);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,rows,mode})+'\n',error=>{if(error)this.close(error);});
    });
  }
  close(reason=new Error('SemIf worker closed'),terminate=true){
    if(this.closed)return;this.closed=true;clearTimeout(this.deadlineTimer);
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(reason);}this.pending.clear();
    this.child.stdin.end();
    if(terminate&&this.child.pid){
      if(process.platform==='win32'){
        // Python's Windows venv launcher may own a second interpreter. Stop only our tree.
        const killer=spawn('taskkill',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>this.child.kill());
      }else this.child.kill();
    }
  }
}
