import PrivateEquityPublicPage, { type PrivateEquityPublicRoute } from "./PrivateEquityPublicPage"

export type CentropyMarketingRoute = Exclude<PrivateEquityPublicRoute, "home">

export default function CentropyMarketingPage({ route }: { route: CentropyMarketingRoute }) {
  return <PrivateEquityPublicPage route={route} />
}
