import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Injecte une CSP stricte uniquement au build de production.
 * En dev, le HMR et react-refresh nécessitent des scripts inline —
 * la CSP serait contournée de toute façon, autant ne pas donner
 * l'illusion d'une protection.
 */
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'";

function cspPlugin(): Plugin {
  return {
    name: "inject-csp-prod",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.server) return html; // dev : inchangé
        return html.replace(
          "</head>",
          `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
        );
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin()],
  // base relatif pour le chargement via file:// dans Electron en production.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
