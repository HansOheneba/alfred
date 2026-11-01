/** Which screen "/" opens on. Chat is the default until a person picks Overview in Settings. */
export type HomeScreen = "chat" | "overview";

export const HOME_COOKIE = "alfred-home";

export const HOME_PATHS: Record<HomeScreen, string> = { chat: "/chat", overview: "/dashboard" };

export function readHome(value: string | undefined): HomeScreen {
  return value === "overview" ? "overview" : "chat";
}
