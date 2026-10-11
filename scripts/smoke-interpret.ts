import { loadEnvFile } from "node:process";

import { interpretMessage } from "@/lib/ai/deepseek";

loadEnvFile();

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL;
  if (!apiKey || !model) throw new Error("DeepSeek is not configured");
  const action = await interpretMessage(
    { apiKey, model },
    {
      text: "I spent GH₵45 on lunch",
      timezone: "Africa/Accra",
      currency: "GHS",
      now: new Date("2026-10-11T15:00:00.000Z"),
      recent: [],
    },
  );
  if (action.type !== "create_transaction") {
    console.log(JSON.stringify({ type: action.type }));
    return;
  }
  console.log(
    JSON.stringify({
      type: action.type,
      explicit: action.explicit,
      items: action.transactions.map((item) => ({
        type: item.transaction_type,
        amount: item.amount,
        currency: item.currency,
        category: item.category,
        description: item.description,
        date: item.date ?? null,
      })),
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.name : "error";
  console.error(message);
  process.exitCode = 1;
});
