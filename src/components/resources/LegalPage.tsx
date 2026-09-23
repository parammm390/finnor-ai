import type { ReactNode } from "react"
import CentropyNavigation from "@/components/rebuild/CentropyNavigation"
import styles from "./LegalPage.module.css"

export function LegalPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}><CentropyNavigation /><main>{children}</main></div>
}

export { styles as legalStyles }
