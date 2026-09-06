import {
  quarantineRetiredWaterWebhook,
  verifyGhlSignature,
} from "../../../../lib/retired-water-webhook";

export async function POST(req: Request): Promise<Response> {
  return quarantineRetiredWaterWebhook(
    req,
    "ghl",
    (request, rawBody) => verifyGhlSignature(request, rawBody),
  );
}
