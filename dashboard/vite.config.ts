/**
 * Vite build + vitest config.
 *
 * - `base: "/ghtraffic/"`: the site is served at https://thorwhalen.github.io/ghtraffic/.
 * - A Content-Security-Policy is added to the BUILT page only (the dev server
 *   needs inline scripts for hot reload). It allows scripts and styles from the
 *   page itself only, and network requests to the page's origin plus HTTPS
 *   (api.github.com for the private-repo source, any HTTPS host for
 *   `?data=<url>`). No third-party script, font or analytics is ever loaded.
 */
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React `style={...}` attributes (chart widths, colours)
  "img-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "ghtraffic-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  base: "/ghtraffic/",
  plugins: [react(), cspPlugin()],
  build: { target: "es2020", sourcemap: false },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
