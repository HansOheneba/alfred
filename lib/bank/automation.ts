import type { SupabaseSettings,UserProfile } from '@/lib/config';
import { logError } from '@/lib/log';
import { recoverIncomingPaymentMentions } from './notices';
import { recoverPaymentNotifications,drainOwnerNotifications } from '@/lib/notifications/service';
import { loadNotificationPreferences } from '@/lib/notifications/store';

/** Bookkeeping is already committed. Independent delivery errors never revoke its acknowledgement. */
export async function deliverBankAutomation(settings:SupabaseSettings,profile:UserProfile,deadlineAt=Date.now()+25_000):Promise<void>{
  if(Date.now()>=deadlineAt)return;
  const prefs=await loadNotificationPreferences(settings,profile.profileId).catch(()=>{logError('bank_notice_preferences',new Error('Notification preferences could not be loaded.'));return null;});
  if(!prefs||(!prefs.paymentMentions&&!prefs.paymentPush)||Date.now()>=deadlineAt)return;
  if(prefs.paymentMentions)await recoverIncomingPaymentMentions(settings,profile.profileId,new Date(),Math.min(deadlineAt,Date.now()+10_000),{ownerId:profile.profileId,preferences:prefs}).catch(()=>logError('bank_private_notice',new Error('Private payment notice recovery could not complete.')));
  // Bill/weekly recovery is owned by the scheduled dispatcher. A bank event
  // need not inspect or drain device delivery when payment nudges are off.
  if(!prefs.paymentPush)return;
  if(Date.now()>=deadlineAt)return;
  await recoverPaymentNotifications(settings,profile.profileId,{deadlineAt}).catch(()=>logError('bank_push_enqueue',new Error('Payment notification recovery could not complete.')));
  if(Date.now()>=deadlineAt)return;
  await drainOwnerNotifications(settings,profile.profileId,{timeBudgetMs:Math.max(0,deadlineAt-Date.now())}).catch(()=>logError('bank_push_delivery',new Error('Payment notification delivery could not complete.')));
}
