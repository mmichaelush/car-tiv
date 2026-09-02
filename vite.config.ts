import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Multi-page build.
 *
 * Every public URL of the site has its own HTML entry point at the repository
 * root, mirroring the URL path (`channels/index.html` -> `/channels/`). The HTML
 * files are thin shells: they contain the static, crawlable markup for the page
 * plus a single module script from `src/app`. Keeping the folder layout equal to
 * the URL layout means the built `dist/` can be served by Workers Static Assets
 * with no rewrite table beyond the dynamic routes handled in `worker/`.
 */
const pages = {
  home: 'index.html',
  video: 'video/index.html',
  channels: 'channels/index.html',
  channel: 'channel/index.html',
  category: 'category/index.html',
  search: 'search/index.html',
  library: 'library/index.html',
  addVideo: 'add-video/index.html',
  about: 'about/index.html',
  contact: 'contact/index.html',
  privacy: 'privacy/index.html',
  terms: 'terms/index.html',
  admin: 'admin/index.html',
} as const;

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  appType: 'mpa',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': resolvePath('./shared'),
      '@src': resolvePath('./src'),
    },
  },
  server: {
    port: 5173,
    // During `vite dev` the API lives in `wrangler dev` on 8787. This keeps the
    // browser talking to same-origin `/api/*` URLs in every environment.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: true,
    // Performance budget. Anything above this is a bug to investigate, not a
    // warning to silence.
    //
    // The one deliberate exception is `xlsx` (~430 kB), the spreadsheet reader
    // behind the admin's bulk import. It is a dynamic `import()`, so it is
    // fetched only when a staff member actually picks an `.xlsx` file — never
    // by a visitor, and never by the rest of the admin. The limit is set just
    // above it rather than at it, so our own chunks (largest: ~57 kB) still
    // have a very long way to go before they stop being noticed.
    chunkSizeWarningLimit: 450,
    rollupOptions: {
      input: Object.fromEntries(
        Object.entries(pages).map(([name, file]) => [name, resolvePath(`./${file}`)]),
      ),
    },
  },
});
