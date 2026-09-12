import type { Metadata } from "next";

import { LegalPage, legalStyles as styles } from "@/components/resources/LegalPage";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How FINNOR handles website inquiries and separately scoped production data.",
  alternates: { canonical: "https://finnorai.com/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage>
      <article className={styles.legal}>
        <span className={styles.legalMeta}>FINNOR / Privacy overview</span>
        <h1>Privacy</h1>
        <div className={styles.legalBody}>
          <section><h2>Information we collect</h2><p>When you contact FINNOR, we may collect the information you submit, including your name, work email, company, phone number, website URL and the operating scope you want to discuss.</p></section>
          <section><h2>Website inquiries</h2><p>Use the public website only for business inquiries and deployment discussions. Do not submit confidential customer records, payment data or other sensitive operational information through a website inquiry.</p></section>
          <section><h2>How information is used</h2><p>We use inquiry information to respond to you, understand product interest, plan an operating review, operate and secure the website, and improve FINNOR.</p></section>
          <section><h2>Production deployments</h2><p>A production deployment is separately scoped. Data sources, processors, access controls, retention, routing, audit requirements and vendor terms are reviewed for that company before activation.</p></section>
          <section><h2>Security and retention</h2><p>FINNOR applies access and operational controls appropriate to the relevant environment. Retention depends on the data type, purpose and applicable deployment agreement. No website can promise absolute security.</p></section>
          <section><h2>Questions and requests</h2><p>For privacy questions or requests related to information you provided, contact <a href="mailto:param@finnorai.com">param@finnorai.com</a>.</p></section>
        </div>
      </article>
    </LegalPage>
  );
}
