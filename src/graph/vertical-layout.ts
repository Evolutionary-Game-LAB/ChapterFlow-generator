import type {Story} from '../schema.js';

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 104;
export const GRAPH_ROW_GAP = 66;
const LANE_GAP = 54;
const EXIT = '\0layout-exit';
export type GraphPoint = {x:number;y:number};
type Region = {width:number;ids:Set<string>;items:{id:string;branches?:Region[]}[]};
// Balance comparable lanes, without doubling the width at every nested early exit.
function branchWidths(branches:Region[]):number[] {
  const widths=branches.map(b=>b.width),max=Math.max(...widths);
  return max<=Math.min(...widths)*2.5?widths.map(()=>max):widths;
}

/** Presentation-only fork/join layout. No narrative IDs, edges or conditions are changed. */
export function verticalGraphPositions(graph:Story['graph']):Map<string,GraphPoint> {
  const ids=graph.nodes.map(n=>n.id),valid=new Set(ids);
  const outgoing=new Map(ids.map(id=>[id,[] as string[]]));
  const incoming=new Map(ids.map(id=>[id,[] as string[]]));
  for(const e of graph.edges)if(valid.has(e.from)&&valid.has(e.to)&&!outgoing.get(e.from)!.includes(e.to)){
    outgoing.get(e.from)!.push(e.to);incoming.get(e.to)!.push(e.from);
  }
  const pending=new Map(ids.map(id=>[id,incoming.get(id)!.length]));
  const order=ids.filter(id=>!pending.get(id));
  const rank=new Map(ids.map(id=>[id,0]));
  for(let i=0;i<order.length;i++)for(const next of outgoing.get(order[i])!){
    rank.set(next,Math.max(rank.get(next)!,rank.get(order[i])!+1));
    pending.set(next,pending.get(next)!-1);if(!pending.get(next))order.push(next);
  }
  const positions=new Map<string,GraphPoint>();
  if(order.length===ids.length){
    const last=Math.max(0,...rank.values());
    for(const node of graph.nodes)if(node.type==='end'&&!outgoing.get(node.id)!.length)rank.set(node.id,last);
    const post=new Map<string,Set<string>>([[EXIT,new Set([EXIT])]]);
    for(const id of [...order].reverse()){
      const next=outgoing.get(id)!.length?outgoing.get(id)!:[EXIT];
      const common=new Set(post.get(next[0]));
      for(const child of next.slice(1))for(const p of common)if(!post.get(child)!.has(p))common.delete(p);
      common.add(id);post.set(id,common);
    }
    const joins=new Map(ids.map(id=>[id,[...post.get(id)!].filter(p=>p!==id).sort((a,b)=>post.get(b)!.size-post.get(a)!.size)[0]??EXIT]));
    const region=(entry:string,stop:string):Region=>{
      const result:Region={width:GRAPH_NODE_WIDTH,ids:new Set(),items:[]};
      let id=entry;
      while(id!==stop&&id!==EXIT){
        if(result.ids.has(id))throw new Error('Non-series-parallel region');
        result.ids.add(id);const item:Region['items'][number]={id};result.items.push(item);
        const next=outgoing.get(id)!;
        if(next.length<2){id=next[0]??EXIT;continue;}
        const join=joins.get(id)!;
        item.branches=next.map(child=>region(child,join));
        const widths=branchWidths(item.branches);
        result.width=Math.max(result.width,widths.reduce((a,b)=>a+b,0)+LANE_GAP*(next.length-1));
        for(const branch of item.branches)for(const key of branch.ids){
          if(result.ids.has(key))throw new Error('Overlapping branch regions');
          result.ids.add(key);
        }
        id=join;
      }
      return result;
    };
    const place=(r:Region,center:number)=>{
      for(const item of r.items){
        positions.set(item.id,{x:center-GRAPH_NODE_WIDTH/2,y:80+rank.get(item.id)!*(GRAPH_NODE_HEIGHT+GRAPH_ROW_GAP)});
        if(item.branches){const widths=branchWidths(item.branches);let left=center-(widths.reduce((a,b)=>a+b,0)+LANE_GAP*(widths.length-1))/2;item.branches.forEach((b,i)=>{place(b,left+widths[i]/2);left+=widths[i]+LANE_GAP;});}
      }
    };
    try {
      const roots=ids.filter(id=>!incoming.get(id)!.length).sort((a,b)=>Number(b===graph.startNodeId)-Number(a===graph.startNodeId));
      let left=80;
      for(const root of roots){const r=region(root,EXIT);for(const id of r.ids)if(positions.has(id))throw new Error('Shared disconnected region');place(r,left+r.width/2);left+=r.width+LANE_GAP;}
      if(positions.size===ids.length)return positions;
    }catch{ /* Irreducible DAGs still get a bounded layered layout below. */ }
  } else {
    // Imported editable graphs may contain cycles. Keep them finite and editable.
    for(const id of ids.filter(id=>!order.includes(id)))rank.set(id,order.length+ids.indexOf(id));
  }
  positions.clear();
  const rows=new Map<number,string[]>();
  for(const id of ids){const row=rank.get(id)!;rows.set(row,[...(rows.get(row)??[]),id]);}
  const sorted=[...rows.keys()].sort((a,b)=>a-b);
  const column=new Map(ids.map((id,i)=>[id,i]));
  for(let pass=0;pass<6;pass++)for(const row of pass%2?[...sorted].reverse():sorted){
    const neighbor=pass%2?outgoing:incoming;
    const score=(id:string)=>{const list=neighbor.get(id)!;return list.length?list.reduce((s,n)=>s+column.get(n)!,0)/list.length:column.get(id)!;};
    rows.get(row)!.sort((a,b)=>score(a)-score(b));rows.get(row)!.forEach((id,i)=>column.set(id,i));
  }
  const width=Math.max(1,...[...rows.values()].map(r=>r.length))*(GRAPH_NODE_WIDTH+LANE_GAP);
  for(const [row,list]of rows)list.forEach((id,i)=>positions.set(id,{x:80+width/2+(i-(list.length-1)/2)*(GRAPH_NODE_WIDTH+LANE_GAP)-GRAPH_NODE_WIDTH/2,y:80+row*(GRAPH_NODE_HEIGHT+GRAPH_ROW_GAP)}));
  return positions;
}
