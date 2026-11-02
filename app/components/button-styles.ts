import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

/** Shared presentation for action buttons and links, usable in server and client components. */
export function buttonClassName({ variant = "secondary", size = "md", className = "" }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return `alfred-button alfred-button--${variant} alfred-button--${size}${className ? ` ${className}` : ""}`;
}
