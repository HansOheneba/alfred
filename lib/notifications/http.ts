export function sameOrigin(request:Request):boolean {
  try{return request.headers.get("origin")===new URL(request.url).origin;}catch{return false;}
}
/** Binds a click to the account displayed when consent was given. Authentication
 * still determines ownership; a caller cannot select another owner here. */
export function displayedOwnerMatches(request:Request,ownerId:string):boolean {
  return request.headers.get("x-alfred-owner")===ownerId;
}
export async function notificationJSON(request:Request):Promise<unknown> {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type")??""))throw Error("Use a JSON request.");
  if(Number(request.headers.get("content-length")??0)>4096)throw Error("Notification request is too large.");
  const reader=request.body?.getReader();if(!reader)throw Error("A JSON request is required.");
  const pieces:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw Error("Notification request is too large.");}pieces.push(value);}
  const body=new Uint8Array(size);let offset=0;for(const piece of pieces){body.set(piece,offset);offset+=piece.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(body));}catch{throw Error("That notification request could not be read.");}
}
export function privateJSON(value:unknown,status=200):Response {
  return Response.json(value,{status,headers:{"cache-control":"private, no-store","vary":"Cookie, Origin"}});
}
