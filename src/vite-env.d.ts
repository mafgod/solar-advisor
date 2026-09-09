/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AMAZON_TAG?: string
  readonly VITE_ALIEXPRESS_AFF?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
