import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import nodemailer from "nodemailer"
import { serverEnv } from "@/lib/env"
import { assertBodySize, cleanString, escapeHtml, isEmail } from "@/lib/api/request"
import { rateLimit } from "@/lib/api/rate-limit"

export const runtime = "nodejs"
export const maxDuration = 20

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request, { name: "contact", limit: 6, windowMs: 10 * 60 * 1000 })
    if (limited) return limited

    assertBodySize(request, 64_000)
    const formData = await request.formData()

    if (cleanString(formData.get("website_url"), 200)) {
      return NextResponse.json({ success: true })
    }

    const name = cleanString(formData.get("name"), 120)
    const email = cleanString(formData.get("email"), 180)
    const company = cleanString(formData.get("company"), 160)
    const phone = cleanString(formData.get("phone"), 80)
    const workflow = cleanString(formData.get("workflow"), 500)

    if (!name || !email || !workflow) {
      return NextResponse.json(
        { error: "Name, email, and PE workflow are required." },
        { status: 400 }
      )
    }

    if (!isEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 })
    }

    await persistContactLead({ name, email, company, phone, workflow })
    await sendContactNotification({ name, email, company, phone, workflow })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Contact form error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    )
  }
}

async function persistContactLead({
  name,
  email,
  company,
  phone,
  workflow,
}: {
  name: string
  email: string
  company: string
  phone: string
  workflow: string
}) {
  if (!serverEnv.supabaseUrl || !serverEnv.supabaseServiceRoleKey) {
    console.info("FINNOR contact form: Supabase is not configured; skipping database insert.")
    return
  }

  const supabase = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  const { error } = await supabase
    .from("leads")
    .insert([{ name, email, company, phone, message: workflow, status: "new" }])

  if (error) {
    console.info("FINNOR contact form: Supabase insert skipped after database error.")
  }
}

async function sendContactNotification({
  name,
  email,
  company,
  phone,
  workflow,
}: {
  name: string
  email: string
  company: string
  phone: string
  workflow: string
}) {
  if (!serverEnv.gmailUser || !serverEnv.gmailAppPassword) {
    console.info("FINNOR contact form: Gmail notification is not configured; skipping email.")
    return
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: serverEnv.gmailUser,
      pass: serverEnv.gmailAppPassword,
    },
  })

  try {
    await transporter.sendMail({
      from: serverEnv.gmailUser,
      to: "param@finnorai.com",
      subject: `New Lead: ${name} from ${company || "Website"}`,
      text: [
        "New Private Equity operating review request",
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone || "Not provided"}`,
        `Company: ${company || "Not provided"}`,
        `PE workflow: ${workflow}`,
      ].join("\n"),
      html: `
        <h2>New Private Equity operating review request</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(phone || "Not provided")}</p>
        <p><strong>Company:</strong> ${escapeHtml(company || "Not provided")}</p>
        <h3>PE workflow:</h3>
        <p>${escapeHtml(workflow)}</p>
      `,
    })
  } catch (error) {
    console.info("FINNOR contact form: email notification failed.", error)
  }
}
