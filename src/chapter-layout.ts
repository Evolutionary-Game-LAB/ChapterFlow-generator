import type {Story} from './schema.js';
import {verticalGraphPositions} from './graph/vertical-layout.js';

/** Keep hand-placed existing nodes stable; new branches occupy a fresh lane. */
export function layoutChapter(story:Story,baseline?:Story,fromKey?:string) {
  if(baseline&&baseline.graph.layout!=='vertical-v1'){
    const oldNodes=new Map(baseline.graph.nodes.map(n=>[n.id,n]));
    const anchor=oldNodes.get('n_'+fromKey);
    const x=Math.max(0,...baseline.graph.nodes.map(n=>n.editor.position.x))+310;
    let y=(anchor?.editor.position.y??0)+210;
    for(const node of story.graph.nodes){
      const old=oldNodes.get(node.id);
      if(old)node.editor=structuredClone(old.editor);
      else{node.editor.position={x,y};y+=210;}
    }
    story.graph.layout='manual';
    return;
  }
  const positions=verticalGraphPositions(story.graph);
  for(const node of story.graph.nodes)node.editor.position=positions.get(node.id)!;
  story.graph.layout='vertical-v1';
}
