import type { Metadata } from "next";

import { AuthForm } from "@/app/auth-form";

export const metadata: Metadata = {
  title: "Sign in · Alfred",
};

export default function LoginPage() {
  return <AuthForm mode="sign-in" />;
}
