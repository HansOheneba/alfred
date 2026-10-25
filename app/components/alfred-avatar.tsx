import Image from "next/image";

export type AlfredAvatarPresentation = "plain" | "glow";

type AlfredAvatarProps = {
  /** Tailwind size classes, for example `size-14` or `size-48`. */
  sizeClass?: string;
  presentation?: AlfredAvatarPresentation;
  className?: string;
  alt?: string;
  sizes?: string;
  loading?: "eager" | "lazy";
};

/**
 * Alfred's assistant mark. The source image is a cutout on a transparent background,
 * so it can sit on the app's own surfaces.
 */
export function AlfredAvatar({
  sizeClass = "size-10",
  presentation = "plain",
  className = "",
  alt = "",
  sizes = "40px",
  loading = "lazy",
}: AlfredAvatarProps) {
  return (
    <span className={`relative block shrink-0 ${sizeClass} ${className}`}>
      {presentation === "glow" ? <span className="alfred-avatar-glow pointer-events-none absolute -inset-6" aria-hidden="true" /> : null}
      <Image src="/alfred.png" alt={alt} fill sizes={sizes} loading={loading} className="object-contain" />
    </span>
  );
}
