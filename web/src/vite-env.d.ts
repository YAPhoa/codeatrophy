/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" by `npm run dev:mock` to run against the in-memory API mock. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
