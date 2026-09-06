import {
  quarantineRetiredWaterWebhook,
  verifyPaymentSignature,
} from "../../../../lib/retired-water-webhook";

export async function POST(req: Request): Promise<Response> {
  return quarantineRetiredWaterWebhook(
    req,
    "payment",
    (request, rawBody) => verifyPaymentSignature(request, rawBody),
  );
}
