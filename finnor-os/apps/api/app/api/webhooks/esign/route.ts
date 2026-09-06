import {
  quarantineRetiredWaterWebhook,
  verifyDocusignSignature,
} from "../../../../lib/retired-water-webhook";

export async function POST(req: Request): Promise<Response> {
  return quarantineRetiredWaterWebhook(
    req,
    "esign",
    (request, rawBody) => verifyDocusignSignature(request, rawBody),
  );
}
