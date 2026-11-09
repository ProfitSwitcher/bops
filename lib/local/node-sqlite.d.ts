declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
    close(): void;
  }
}
