/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Public origin of the app, for the sign-in and request-access links. */
  readonly PUBLIC_APP_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
