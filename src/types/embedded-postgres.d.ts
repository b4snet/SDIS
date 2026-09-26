declare module 'embedded-postgres' {
  interface EmbeddedPostgresOptions {
    port: number;
    databaseDir: string;
    user: string;
    password: string;
    persistent: boolean;
    onLog?: (message: string) => void;
    onError?: (error: Error) => void;
  }

  class EmbeddedPostgres {
    constructor(options: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getPgClient(database: string): import('pg').Client;
  }

  export default EmbeddedPostgres;
}
