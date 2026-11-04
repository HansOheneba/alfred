import type { SupabaseSettings,UserProfile } from '@/lib/config';
import { logError } from '@/lib/log';
import { recoverIncomingPaymentMentions } from './notices';
import { recoverPaymentNotifications,drainOwnerNotifications } from '@/lib/notifications/service';
import { loadNotificationPreferences } from '@/lib/notifications/store';

/** Bookkeeping is already committed. Independent delivery errors never revoke its acknowledgement. */
export async function deliverBankAutomation(settings:SupabaseSettings,profile:UserProfile,deadlineAt=Date.now()+25_000):Promise<void>{
  if(Date.now()>=deadlineAt)return;
  const prefs=await loadNotificationPreferences(settings,profile.profileId).catch(()=>{logError('bank_notice_preferences',new Error('Notification preferences could not be loaded.'));return null;});
  if(!prefs||(!prefs.paymentMentions&&!prefs.outgoingMentions&&!prefs.paymentPush)||Date.now()>=deadlineAt)return;
  // Chat and device delivery are independent consumers of durable bank evidence.
  // A slow chat query must not spend the push transport's completion budget.
  const mentions=async()=>{
    if(prefs.paymentMentions||prefs.outgoingMentions)await recoverIncomingPaymentMentions(settings,profile.profileId,new Date(),Math.min(deadlineAt,Date.now()+10_000),{ownerId:profile.profileId,preferences:prefs}).catch(()=>logError('bank_private_notice',new Error('Private payment notice recovery could not complete.')));
  };
  const devices=async()=>{
    // Bill/weekly recovery belongs to the scheduled dispatcher.
    if(!prefs.paymentPush||Date.now()>=deadlineAt)return;
    await recoverPaymentNotifications(settings,profile.profileId,{deadlineAt}).catch(()=>logError('bank_push_enqueue',new Error('Payment notification recovery could not complete.')));
    if(Date.now()>=deadlineAt)return;
    await drainOwnerNotifications(settings,profile.profileId,{timeBudgetMs:Math.max(0,deadlineAt-Date.now())}).catch(()=>logError('bank_push_delivery',new Error('Payment notification delivery could not complete.')));
  };
  await Promise.all([mentions(),devices()]);
}
