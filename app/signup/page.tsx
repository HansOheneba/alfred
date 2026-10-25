import type { Metadata } from "next";

import { AuthForm } from "@/app/auth-form";

export const metadata: Metadata = {
  title: "Create account · Alfred",
};

export default function SignupPage() {
  return <AuthForm mode="sign-up" />;
}
