import type { ReactNode } from "react"
import FinnorNavigation from "@/components/rebuild/FinnorNavigation"
import styles from "./LegalPage.module.css"

export function LegalPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}><FinnorNavigation /><main>{children}</main></div>
}

export { styles as legalStyles }
