import { Microsoft365AdministrationError } from "@finnor/data-platform";
import { errorResponse } from "./auth";

export function microsoft365AdministrationErrorResponse(error: unknown): Response {
  if (error instanceof Microsoft365AdministrationError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  return errorResponse(error);
}

export function firstQueryValue(url: URL, key: string, maximum = 2_048): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1) return undefined;
  const value = values[0]?.trim();
  return value && value.length <= maximum ? value : undefined;
}
