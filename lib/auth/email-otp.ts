/**
 * Lifetime of an email sign-in code issued by Supabase Auth.
 *
 * Alfred does not generate or expire the code. `createEmailOtp` asks Supabase
 * for `email_otp`, and Auth rejects that code after `mailer_otp_exp`
 * (dashboard: Authentication → Email → Email OTP expiration; CLI key
 * `auth.email.otp_expiry`). This project has no `supabase/config.toml`
 * override. The hosted default is 3600 seconds (1 hour).
 *
 * https://supabase.com/docs/guides/local-development/cli/config#authemailotp_expiry
 */
export const EMAIL_OTP_EXPIRY_SECONDS = 60 * 60;

export function formatEmailOtpExpiry(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error("Email OTP expiry must be a positive whole number of seconds.");
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}
