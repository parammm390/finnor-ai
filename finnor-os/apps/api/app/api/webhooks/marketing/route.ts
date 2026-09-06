import {
  quarantineRetiredWaterWebhook,
  verifySharedSecret,
} from "../../../../lib/retired-water-webhook";

export async function POST(req: Request): Promise<Response> {
  return quarantineRetiredWaterWebhook(
    req,
    "marketing",
    (request) => verifySharedSecret(
      request,
      "x-webhook-secret",
      process.env.MARKETING_WEBHOOK_SECRET ?? process.env.RETIRED_WATER_WEBHOOK_SECRET,
    ),
  );
}
