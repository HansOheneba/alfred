import type { InlineButton } from "@/lib/telegram/client";

/** An answer button under Alfred's question in the web chat: a choice to send back, or a link. */
export type ChatChoice = { label: string; choice: string; href?: undefined } | { label: string; href: string; choice?: undefined };

/** Telegram's answer buttons as web chat choices; links stay on the site. */
export function chatChoices(buttons: InlineButton[][] | undefined): ChatChoice[][] {
  return (buttons ?? [])
    .map((row) =>
      row.flatMap((button): ChatChoice[] => {
        if (button.url) return [{ label: button.text, href: new URL(button.url).pathname }];
        return button.callbackData?.startsWith("b:") ? [{ label: button.text, choice: button.callbackData }] : [];
      }),
    )
    .filter((row) => row.length > 0);
}
