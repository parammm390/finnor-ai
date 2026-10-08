/** Node22 builtin; no third-party SQLite package or candidate DB credential. */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { run(...values: Array<string | number | null>): unknown; get(...values: Array<string | number | null>): unknown; all(...values: Array<string | number | null>): unknown[] };
    close(): void;
  }
}
