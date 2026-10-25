import type { IngestOutcome } from "@/lib/bank/ingest";
import { titleCase } from "@/lib/bank/ingest";
import { parseBankText } from "@/lib/bank/parse";
import { ingestAndAnnounce } from "@/lib/bank/service";
import { createSupabaseBankStore } from "@/lib/bank/store";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { formatAmount } from "@/lib/finance/money";
import type { ImageText } from "@/lib/ocr/read-image";

function line(outcome: IngestOutcome): string {
  const message = outcome.message;
  const money = formatAmount(message.amount, message.currency);
  const who = message.counterparty && !/^gcb/i.test(message.counterparty) ? ` ${message.direction === "out" ? "to" : "from"} ${titleCase(message.counterparty)}` : message.source === "gcb" ? " on your GCB card" : "";
  const what = {
    recorded: `filed under ${outcome.category}`,
    matched: "already in your books, now linked",
    transfer: "your own money moving, not counted",
    loan: "loan deposit, not counted as income",
    needs_label: "what was this?",
  }[outcome.outcome];
  return `• ${money}${who} · ${what}`;
}

/**
 * Handles a screenshot of bank or mobile money texts: files what Alfred can and
 * lists what needs a label. Returns null when the image isn't bank texts, so
 * the caller can treat it as an ordinary message (a receipt, say).
 */
export async function bankScreenshotReply(settings: SupabaseSettings, profile: UserProfile, image: ImageText): Promise<string | null> {
  const parsed = parseBankText(image.text, { now: new Date(), timeZone: profile.timezone });
  if (parsed.length === 0) return null;
  const result = await ingestAndAnnounce(settings, profile, image.text, { channel: "screenshot", announce: false });

  // These questions were asked here in chat, so a typed reply can answer them.
  const bank = createSupabaseBankStore(settings);
  const now = new Date().toISOString();
  await Promise.all(
    result.outcomes.filter((item) => item.outcome === "needs_label").map((item) => bank.updateMessage(profile.profileId, item.message.id, { askedAt: now })),
  );

  if (result.outcomes.length === 0) {
    return result.duplicates > 0 ? "I already have everything in that screenshot. Nothing new to add." : null;
  }
  const lines = [`I read ${result.found} transaction${result.found === 1 ? "" : "s"} from that screenshot:`, ...result.outcomes.map(line)];
  const fees = result.outcomes.filter((item) => item.feeRecorded).reduce((sum, item) => sum + Number(item.message.fee), 0);
  if (fees > 0) lines.push(`• ${formatAmount(fees.toFixed(2), profile.currency)} in fees · filed under Fees`);
  if (result.duplicates > 0) lines.push(`${result.duplicates} ${result.duplicates === 1 ? "was" : "were"} already in your books.`);
  const unlabelled = result.outcomes.filter((item) => item.outcome === "needs_label").length;
  if (unlabelled > 0) {
    lines.push("", unlabelled === 1 ? "Tell me what that one was for, or tap a category under Needs a label." : "Tell me what they were for one at a time, or tap categories under Needs a label.");
  }
  return lines.join("\n");
}
