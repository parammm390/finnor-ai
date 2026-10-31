import type pg from "pg";

export function createNativeOwnerDatabase(): Promise<{
  admin: pg.Client;
  db: typeof import("../../packages/db/index");
  port: number;
  migrations: Awaited<ReturnType<typeof import("../../packages/db/migrate").migrate>>;
  appUrl: string;
  workerUrl: string;
  stop(): Promise<void>;
}>;
