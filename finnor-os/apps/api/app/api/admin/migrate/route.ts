// The historical HTTP migration endpoint is intentionally retained only as an
// authenticated tombstone. Production schema changes now run exclusively through
// the certified, serialized release workflow; a deployed application instance must
// never become a second production mutation authority.

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return Response.json({ error: "Retired: use the certified production release migration" }, { status: 410 });
}
