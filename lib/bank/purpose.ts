/** Saved classification, never an inferred purpose from a sender or raw SMS. */
export type StoredPaymentPurpose={ownerId:string;transactionId:string;category:string;description:string;recordStatus:string};
const VAGUE=new Set(['other','misc','miscellaneous']);
function safe(value:string):string|null{
 if(/https?:\/\/|www\.|[<>\[\]`]/i.test(value))return null;
 return value.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,120);
}
export function classificationMeaning(category:string,description:string,counterparty=''):{category:string;detail:string|null}|null{
 const name=safe(category),body=safe(description),party=safe(counterparty)?.toLowerCase();
 if(!name)return null;
 const text=body?.toLowerCase()??'';
 const generic=!text||text===name.toLowerCase()||text===party||/^(?:bank\s+)?(?:payment|incoming payment|income|expense|deposit|transfer)(?:\s+(?:received|from|to|by)\b.*)?$/.test(text)||/^(?:money received|gcb card (?:top-up|payment))$/.test(text)||/^(?:from|to|into)\s+/.test(text);
 const detail=generic?null:body!;
 return VAGUE.has(name.toLowerCase())&&!detail?null:{category:name,detail};
}
export function knownPaymentPurpose(purpose:StoredPaymentPurpose|null|undefined,ownerId:string,transactionId:string|null,counterparty=''){
 if(!purpose||!transactionId||purpose.ownerId!==ownerId||purpose.transactionId!==transactionId||purpose.recordStatus!=='active')return null;
 return classificationMeaning(purpose.category,purpose.description,counterparty);
}
