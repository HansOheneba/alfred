import {createHash} from "node:crypto";
import {canonicalStringify} from "../../portability/archive.mjs";
import type {ImportArchive} from "./model";
import type {NativeRestoreSource,NativeRestoreInput} from "./native-restoration";
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export type NativeAccountReference={id:string;namespace:string;sourceId:string};
/** Only documented retained-archive locations are traversed. Nested cash cores are never imported. */
export function collectNativeRestoreSources(archive:ImportArchive):NativeRestoreSource[] {
 const queue:{manifest:Record<string,unknown>;datasets:Record<string,unknown>;depth:number;outer:boolean}[]=[{manifest:archive.manifest as unknown as Record<string,unknown>,datasets:archive.datasets,depth:0,outer:true}];
 const candidates:{source:NativeRestoreSource;at:number;outer:boolean}[]=[];let visited=0,limited=false;
 const seen=new Set<string>();
 while(queue.length) {
  if(visited++>=32){limited=true;break;}
  const entry=queue.shift()!;const namespace=entry.manifest.namespace;
  if(typeof namespace!=="string"||!namespace||namespace.length>300)continue;
  const native=entry.datasets["alfred.native"];
  if(object(native)&&native.schema===1&&object(native.tables)) {
   const accountRows=Array.isArray(entry.datasets.accounts)?entry.datasets.accounts:object(native.tables)&&Array.isArray(native.tables.accountingStates)&&object(native.tables.accountingStates[0])&&object(native.tables.accountingStates[0].state)&&Array.isArray(native.tables.accountingStates[0].state.accounts)?native.tables.accountingStates[0].state.accounts:[];
   const accountReferences:NativeAccountReference[]=accountRows.filter(object).filter(row=>typeof row.id==="string").map(row=>{const origin=object(row.importProvenance)?row.importProvenance:{};return{id:String(row.id),namespace:typeof origin.namespace==="string"?origin.namespace:namespace,sourceId:typeof origin.sourceId==="string"?origin.sourceId:String(row.id)};});
   const key=createHash("sha256").update(canonicalStringify({namespace,native,accountReferences})).digest("hex");
   if(!seen.has(key)){seen.add(key);candidates.push({source:{namespace,native:native as unknown as NativeRestoreInput,accountReferences},at:typeof entry.manifest.exportedAt==="string"?Date.parse(entry.manifest.exportedAt)||0:0,outer:entry.outer});}
  }
  const enqueue=(value:unknown)=>{
   if(entry.depth>=8){limited=true;return;}
   if(!object(value))return;
   const wrapper=object(value.archive)?value.archive:value;
   const manifest=object(wrapper.manifest)?wrapper.manifest:object(wrapper.sourceManifest)?wrapper.sourceManifest:null;
   if(manifest&&object(wrapper.datasets))queue.push({manifest,datasets:wrapper.datasets,depth:entry.depth+1,outer:false});
  };
  if(Array.isArray(entry.datasets.preservedArchives))entry.datasets.preservedArchives.forEach(enqueue);
  for(const key of ["alfred.native","moneyTracker.native"]) {
   const source=entry.datasets[key];if(object(source)&&Array.isArray(source.retainedArchives))source.retainedArchives.forEach(enqueue);
  }
 }
 // A native snapshot is complete for its namespace. Older snapshots must not resurrect deleted
 // native records. An outer Alfred snapshot is authoritative for all of its current table domains.
 candidates.sort((a,b)=>Number(b.outer)-Number(a.outer)||b.at-a.at);
 const outer=candidates.find(item=>item.outer);const claimed=new Set<string>();const result:NativeRestoreSource[]=[];
 for(const item of candidates) {
  if(claimed.has(item.source.namespace))continue;claimed.add(item.source.namespace);
  if(!item.outer&&outer)continue;
  result.push(item.source);
 }
 if(limited){const warning="Additional retained archive wrappers remain saved. This preview reviews at most 32 documented wrappers and eight nesting levels; it does not recursively replay arbitrary JSON.";if(result.length)result[0].warnings=[...(result[0].warnings??[]),warning];else result.push({namespace:archive.manifest.namespace,native:{schema:1,tables:{}},warnings:[warning]});}
 return result;
}
