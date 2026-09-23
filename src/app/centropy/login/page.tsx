import type { Metadata } from "next"
import { LoginForm } from "@/components/centropy/lib/LoginForm"

export const metadata: Metadata = {
  title: "Sign in — CENTROPY",
  description: "Sign in to your CENTROPY command center.",
}

export default function CentropyLoginPage() {
  return <LoginForm />
}
