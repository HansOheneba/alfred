import { createHash } from "node:crypto";
import type { ChatMessageRecord, MessageLog } from "@/lib/accounts/messages";
import type { TurnReply } from "@/lib/conversation/turn";
import { formatAmount, toMinor } from "@/lib/finance/money";
import type { PaymentResolutionContext, PaymentResolutionDeps, ReturnOriginal } from "./payment-resolutions";

type Proposal = { kind: "failed" | "not_completed" | "reopen" } | { kind: "returned"; originalId: string; returnBankMessageId: string; principalMinor: number };
const affirmative = (text: string) => /^(?:yes|yeah|yep|correct|confirm|that['’]s right)[.!]*$/i.test(text.trim());
function requestKind(text: string): "failed" | "not_completed" | "returned" | "reopen" | null {
  const said=text.normalize("NFKC").trim();
  if(said.length>400||/[\n;?]|\b(?:maybe|perhaps|think|guess|probably)\b/i.test(said))return null;
  if(/^(?:please\s+)?(?:undo|unlink|reopen)\b.{0,50}\b(?:refund|return|resolution|payment)\b/i.test(said))return "reopen";
  if(/\b(?:actually|correction|i was wrong)\b.{0,40}\b(?:money (?:did )?(?:move|leave)|(?:it|payment|transfer) (?:did )?(?:complete|go through)|completed)\b/i.test(said))return "reopen";
  if(/\b(?:reversed|reversal|refunded|refund|returned|came back|money back)\b/i.test(said)&&!/\b(?:not|never|hasn['’]t|wasn['’]t|didn['’]t)\b/i.test(said))return "returned";
  if(/\b(?:failed|declined|unsuccessful|didn['’]t go through|did not go through)\b/i.test(said))return "failed";
  return /\b(?:no money (?:moved|left|went)|nothing (?:moved|left)|(?:it|payment|transfer) (?:didn['’]t|did not) complete|not completed)\b/i.test(said)?"not_completed":null;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function intent(context:PaymentResolutionContext,proposal:Proposal):string {
  return `bank:resolution:${encode(proposal)}:${context.evidenceFingerprint}`;
}
function savedProposal(last:ChatMessageRecord|undefined,context:PaymentResolutionContext):Proposal|null {
  if(last?.role!=="assistant"||last.channel!=="web"||last.paymentNotice?.bankMessageId!==context.bankMessageId||!last.intent?.startsWith("bank:resolution:"))return null;
  const match=/^bank:resolution:([A-Za-z0-9_-]+):([a-f0-9]{64})$/.exec(last.intent);
  if(!match||match[2]!==context.evidenceFingerprint)return null;
  try{
    const data=JSON.parse(Buffer.from(match[1],"base64url").toString()) as Proposal;
    if(["failed","not_completed","reopen"].includes(data.kind))return data;
    return data.kind==="returned"&&typeof data.originalId==="string"&&typeof data.returnBankMessageId==="string"&&Number.isSafeInteger(data.principalMinor)&&data.principalMinor>0?data:null;
  }catch{return null;}
}
const safe=(value:string)=>value.replace(/[\u0000-\u001f\u007f\p{Cf}<>\[\]`]/gu," ").replace(/https?:\/\/\S+|www\.\S+/gi,"").replace(/\s+/g," ").trim().slice(0,80);
function originalList(context:PaymentResolutionContext):string {
  return context.originals.slice(0,5).map(row=>`${formatAmount((row.amountMinor/100).toFixed(2),row.currency)} on ${row.date}${safe(row.description)?` · ${safe(row.description)}`:""}`).join("; ");
}
function returnSelection(text:string,context:PaymentResolutionContext):Proposal|null {
  // Explicit figures only. Never take an unspoken full original amount as the return.
  const currencyWords=text.match(/\b(?:GHS|USD|EUR|GBP|NGN)\b/gi)??[];
  if(currencyWords.some(value=>value.toUpperCase()!==context.source?.currency))return null;
  const dates=text.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[];
  const prose=text.replace(/\b\d{4}-\d{2}-\d{2}\b/g,"");
  if(/[+\-−]\s*(?:[A-Z]{3}\s*)?\d/.test(prose))return null;
  const values=[...prose.matchAll(/\b\d[\d,]*(?:\.\d{1,2})?\b/g)].map(row=>{try{return toMinor(row[0].replaceAll(",",""));}catch{return 0;}}).filter(value=>value>0);
  if(!values.length||values.length>2)return null;
  const principalMinor=values[0];
  const returns=context.returns.filter(row=>row.amountMinor===principalMinor);
  if(returns.length!==1)return null;
  const originals=context.originals.filter(row=>(values.length<2||row.amountMinor===values[1])&&(dates.length===0||dates.length===1&&row.date===dates[0]));
  if(originals.length!==1||principalMinor>originals[0].remainingMinor)return null;
  return {kind:"returned",originalId:originals[0].id,returnBankMessageId:returns[0].bankMessageId,principalMinor};
}
function returnQuestion(context:PaymentResolutionContext,proposal:Extract<Proposal,{kind:"returned"}>,original:ReturnOriginal):string {
  return `Should I link ${formatAmount((proposal.principalMinor/100).toFixed(2),original.currency)} as returned principal from your ${formatAmount((original.amountMinor/100).toFixed(2),original.currency)} payment on ${original.date}? This reduces the original spending by only the returned amount, without removing recorded fees.`;
}

/** The original user's words start a concrete question. Only the exact saved
 * server proposal plus unchanged owned evidence can turn a later yes into a write. */
export async function answerPaymentResolution(input:{text:string;ownerId:string;focus?:ChatMessageRecord["paymentNotice"]|null;clientId?:string;messages?:MessageLog|null;service?:PaymentResolutionDeps|null}):Promise<TurnReply|null>{
  if(!input.focus||!input.service)return null;
  let kind=requestKind(input.text);const yes=affirmative(input.text),possibleSelection=!kind&&/\d/.test(input.text);
  if(!kind&&!yes&&!possibleSelection)return null;
  const history=(yes||possibleSelection)&&input.messages?(await input.messages.listRecent(input.ownerId,6)).filter(row=>!input.clientId||row.clientId!==input.clientId):[];
  const last=history.at(-1);
  if((yes||possibleSelection)&&!last?.intent?.startsWith("bank:resolution:")&&!last?.intent?.startsWith("bank:resolution-select:"))return null;
  let context:PaymentResolutionContext;
  try{context=await input.service.inspect(input.ownerId,input.focus.bankMessageId);}catch{return {kind:"text",text:"I couldn't check the captured payment right now. Nothing has been confirmed; try again shortly.",intent:"bank:resolution-unavailable",paymentNotice:input.focus};}
  if(context.ownerId!==input.ownerId||context.bankMessageId!==input.focus.bankMessageId)return null;
  const reply=(text:string,requiresPurpose=true,proposal?:Proposal):TurnReply=>({kind:"text",text,intent:proposal?intent(context,proposal):"bank:resolution-result",paymentNotice:{bankMessageId:context.bankMessageId,requiresPurpose}});
  if(context.availability!=="ready")return reply("Payment exception setup is not ready yet. I'll keep the original payment unchanged; please try again after setup is complete.",Boolean(input.focus.requiresPurpose));
  if(!context.source||context.source.ownerId!==input.ownerId||context.source.id!==context.bankMessageId)return reply("I couldn't find that captured payment in your account. Nothing was changed.",false);
  if(possibleSelection){
    if(last?.role!=="assistant"||last.paymentNotice?.bankMessageId!==context.bankMessageId||last.intent!==`bank:resolution-select:${context.evidenceFingerprint}`)return reply("The matching payment records changed. Tell me which return and original payment you mean again.",context.source.status==="needs_label");
    kind="returned";
  }
  const proposal=yes?savedProposal(last,context):null;
  if(yes&&!proposal)return reply("The payment or its matching records changed since that question. Please tell me what happened again so I can check the current evidence.",context.source.status==="needs_label");
  if(proposal){
    try{
      const requestId=input.clientId??`resolution_${createHash("sha256").update(`${input.ownerId}\0${context.bankMessageId}\0${last!.intent}`).digest("hex")}`;
      const result=proposal.kind==="reopen"?await input.service.reopen(input.ownerId,context.bankMessageId,{requestId,evidenceFingerprint:context.evidenceFingerprint})
        :proposal.kind==="returned"?await input.service.returned(input.ownerId,context.bankMessageId,{requestId,evidenceFingerprint:context.evidenceFingerprint,originalId:proposal.originalId,returnBankMessageId:proposal.returnBankMessageId,principalMinor:proposal.principalMinor})
          :await input.service.noMoney(input.ownerId,context.bankMessageId,{requestId,evidenceFingerprint:context.evidenceFingerprint,reason:proposal.kind});
      if(result.status==="saved"||result.status==="duplicate")return proposal.kind==="reopen"?reply("I've reopened this payment and removed only its saved exception or return link. Its original alert and recorded fees are unchanged. What was it for?",true)
        :proposal.kind==="returned"?reply(`I've linked ${formatAmount((proposal.principalMinor/100).toFixed(2),context.source.currency)} as returned principal against the original payment, rather than new income. Only that amount reduces the original spending; recorded fees remain separate.`,false)
          :reply(`You confirmed that no money moved for this ${context.source.direction==="out"?"outgoing":"incoming"} alert. I've marked it as not completed, so it doesn't count as income or spending. The original alert and any recorded fee are retained.`,false);
      return reply("The records changed or this payment has a protected classification. I haven't confirmed a change. Tell me what happened again so I can check safely.",context.source.status==="needs_label");
    }catch{return reply("I couldn't confirm whether the resolution was saved. Refresh this conversation to check its current state before trying again.",false);}
  }
  if(kind==="reopen")return context.resolved?reply(context.resolved==="not_completed"?"Should I reopen this alert as a payment awaiting explanation? This reverses your earlier no-money-moved confirmation while preserving the original alert and recorded fees.":"Should I unlink this incoming alert from the returned principal and reopen it awaiting explanation? Other returned amounts and recorded fees will stay intact. I will stop if later edits make this unsafe.",false,{kind:"reopen"}):reply("This alert does not have a saved exception I can safely reopen. Nothing was changed.",context.source.status==="needs_label");
  if(context.resolved)return reply(context.resolutionNotice??"This payment has a saved exception, but I need to check its current classification before relying on it. Nothing was changed.",false);
  if(kind==="failed"||kind==="not_completed")return context.noMoneyAllowed?reply(`Did no money move for this ${context.source.direction==="out"?"outgoing":"incoming"} alert for ${formatAmount(context.source.amount,context.source.currency)}? Confirm only if it did not complete. If money left and then came back, tell me it was returned instead. Any recorded fee will stay recorded.`,true,{kind})
    :reply("This payment already has a classification, hold or financial link. I won't remove that on a failure statement alone. Tell me what needs correcting so the existing record can be checked.",context.source.status==="needs_label");
  if(kind==="returned"){
    if(!context.originals.length)return reply(context.source.direction==="out"&&context.source.status==="needs_label"
      ? "First, tell me what this outgoing payment was for. Once it is filed, tell me how much came back so I can link the actual incoming alert without assuming a full refund."
      : "The original outgoing payment must be recorded and explained first. Open its own earlier message or notification in Chat and explain that outgoing payment there, then return to this incoming alert to link the money back. Don't label this credit as spending or new income; I'll keep it pending.",context.source.status==="needs_label");
    if(!context.returns.length)return reply("I haven't found an unresolved incoming alert to use as the return. Tell me when and how much came back, or wait for the actual credit alert. I won't invent a return or remove the original payment.",context.source.status==="needs_label");
    const selected=returnSelection(input.text,context);
    if(selected?.kind==="returned")return reply(returnQuestion(context,selected,context.originals.find(row=>row.id===selected.originalId)!),true,selected);
    return {...reply(`How much principal came back, and which original payment was it from? ${context.source.direction==="out"?`Possible incoming returns: ${context.returns.slice(0,5).map(row=>`${formatAmount((row.amountMinor/100).toFixed(2),context.source!.currency)} on ${row.date}`).join("; ")}. `:""}Original payments: ${originalList(context)}. For example, tell me “25 returned from the 100 payment on 2026-11-01”. I won't assume the entire original payment was refunded.`,context.source.status==="needs_label"),intent:`bank:resolution-select:${context.evidenceFingerprint}`};
  }
  return null;
}
