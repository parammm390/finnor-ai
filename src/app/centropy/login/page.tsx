import type { Metadata } from "next"
import { LoginForm } from "@/components/centropy/lib/LoginForm"

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Centropy command center.",
}

export default function CentropyLoginPage() {
  return <LoginForm />
}
