import PrivateEquityPublicPage, { type PrivateEquityPublicRoute } from "./PrivateEquityPublicPage"

export type FinnorMarketingRoute = Exclude<PrivateEquityPublicRoute, "home">

export default function FinnorMarketingPage({ route }: { route: FinnorMarketingRoute }) {
  return <PrivateEquityPublicPage route={route} />
}
