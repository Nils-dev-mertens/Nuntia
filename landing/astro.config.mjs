import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The landing site is its own deployable: static output, no server, no database.
 * The product itself lives in the repository root; nothing here imports from it.
 */
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
})
