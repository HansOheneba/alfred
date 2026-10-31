import type { BankStore } from "@/lib/bank/store";
import { DASHBOARD_URL, type UserProfile } from "@/lib/config";

/**
 * The first thing a new person hears: who Alfred is, the one step that makes
 * him useful, and what to say next. Someone with payments already waiting is
 * offered those straight away.
 */
export async function welcomeFor(profile: UserProfile, bank: BankStore | null | undefined): Promise<string> {
  const name = profile.preferredName.trim();
  const messages = bank ? await bank.listMessages(profile.profileId) : [];
  const waiting = messages.filter((item) => item.status === "needs_label").length;
  const lines = [
    `${name ? `Hi ${name}, I'm` : "Hi, I'm"} Alfred. I keep track of your money from your MoMo and bank texts, so you don't have to type everything in, and I keep up with the people in it: who owes you, who you owe, and who chipped in.`,
  ];
  if (messages.length === 0) {
    lines.push(
      `First step: connect your texts in Settings → Bank messages at ${DASHBOARD_URL}/settings. It takes about two minutes. Until then, just tell me what you spent, like "40 cedis on lunch".`,
    );
  } else if (waiting > 0) {
    lines.push(`${waiting === 1 ? "One payment from your texts is" : `${waiting} payments from your texts are`} waiting for you to tell me what ${waiting === 1 ? "it was" : "they were"}. Say "ask" and I'll go through them.`);
  }
  lines.push(`You can talk to me normally: "who owes me?", "what's left this month?", or "Kofi is my brother" so I remember him.`);
  return lines.join("\n\n");
}
