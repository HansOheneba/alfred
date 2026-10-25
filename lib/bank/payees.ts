/**
 * What Alfred knows about who a payment went to before anyone tells him.
 *
 * Some "payees" are really channels: a MoMo payment to TELECEL PUSH is money
 * sent to a Telecel Cash number on another network, so the text never names
 * the person. Others are well-known merchants that can be filed straight away.
 */

export type PayeeKind =
  | { kind: "channel"; channel: string }
  | { kind: "merchant"; category: string; label: string }
  | { kind: "person" };

const CHANNELS: [RegExp, string][] = [
  [/\btelecel\b|\bvodafone\b/i, "a Telecel Cash number"],
  [/\bairtel\s*tigo\b|\bat\s*(?:push|money)\b/i, "an AirtelTigo Money number"],
  [/\bgh-?link\b|\bgips\b|\bbank\b|\bto account\b/i, "a bank account"],
  [/\bmerchant\b|\bmomopay\b|\bpay ?point\b/i, "a MoMo merchant"],
];

const MERCHANTS: [RegExp, string, string][] = [
  [/\becg\b|electricity company|\bnedco\b|prepaid power/i, "Utilities", "Electricity"],
  [/ghana water|\bgwcl\b/i, "Utilities", "Water bill"],
  [/\bairtime\b|data bundle|\bbundle\b|internet/i, "Utilities", "Airtime and data"],
  [/\bdstv\b|\bgotv\b|multichoice|netflix|spotify|showmax|apple\.com|icloud|youtube/i, "Subscriptions", ""],
  [/\buber\b|\bbolt\b|\byango\b|\btaxify\b/i, "Transport", ""],
  [/\bkfc\b|papaye|chicken republic|pizza ?(?:inn|hut)|domino|starbites|jumia food|glovo|chowdeck/i, "Food", ""],
  [/shoprite|max ?mart|\bmelcom\b|palace mall|china mall|game stores?/i, "Food", "Groceries"],
];

export function classifyPayee(counterparty: string): PayeeKind {
  const name = counterparty.trim();
  if (!name) return { kind: "person" };
  for (const [pattern, category, label] of MERCHANTS) {
    if (pattern.test(name)) return { kind: "merchant", category, label };
  }
  for (const [pattern, channel] of CHANNELS) {
    if (pattern.test(name)) return { kind: "channel", channel };
  }
  return { kind: "person" };
}
