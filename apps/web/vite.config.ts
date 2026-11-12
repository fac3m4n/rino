import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const target = "http://127.0.0.1:3000";
const viteOrigin = "http://127.0.0.1:4173";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request, incoming) => {
            if (
              incoming.headers.host === "127.0.0.1:4173" &&
              incoming.headers.origin === viteOrigin
            )
              request.setHeader("origin", target);
          });
        },
      },
    },
  },
  build: { sourcemap: false },
});
