import { errorResponse, requireContext } from "../../../../lib/auth";
import { readEmployeeDesk } from "../../../../lib/employee-desk";
import { requestEmployee } from "../../../../lib/work-access";

const EMPLOYEE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = { "cache-control": "private, no-store" };

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    if (!EMPLOYEE_UUID.test(requestEmployee(ctx))) {
      return Response.json({ error: "Canonical employee required" }, { status: 403, headers });
    }
    return Response.json({ works: await readEmployeeDesk(ctx) }, { headers });
  } catch (err) {
    const response = errorResponse(err);
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  }
}
