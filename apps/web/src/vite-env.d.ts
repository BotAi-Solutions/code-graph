/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the API in a production build; empty in dev, where Vite proxies. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
