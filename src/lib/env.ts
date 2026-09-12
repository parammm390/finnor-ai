function read(name: string) {
  const value = process.env[name]
  if (typeof value !== "string") return ""

  const trimmed = value.trim()
  if (!trimmed) return ""

  const lower = trimmed.toLowerCase()
  if (
    lower === "your-anon-key" ||
    lower === "your-gemini-api-key" ||
    lower === "your-groq-api-key" ||
    lower === "your-gmail-address" ||
    lower === "your-gmail-app-password" ||
    lower.includes("your-project.supabase.co") ||
    lower.includes("your-server-side-supabase-key") ||
    lower.includes("your-service-role-key")
  ) {
    return ""
  }

  return trimmed
}

export const serverEnv = {
  get groqApiKey() {
    return read("GROQ_API_KEY")
  },
  get groqModel() {
    return read("GROQ_MODEL") || "llama-3.3-70b-versatile"
  },
  get geminiApiKey() {
    return read("GEMINI_API_KEY")
  },
  get geminiModel() {
    return read("GEMINI_MODEL") || "gemini-2.5-flash-lite"
  },
  get supabaseUrl() {
    return read("SUPABASE_URL") || read("NEXT_PUBLIC_SUPABASE_URL")
  },
  get supabaseServiceRoleKey() {
    return read("SUPABASE_SERVICE_ROLE_KEY")
  },
  get gmailUser() {
    return read("GMAIL_USER")
  },
  get gmailAppPassword() {
    return read("GMAIL_APP_PASSWORD")
  },
}
