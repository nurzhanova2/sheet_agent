import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [basicSsl(), react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    https: {},
  },
  build: {
    rollupOptions: {
      input: {
        taskpane: new URL("./taskpane.html", import.meta.url).pathname,
        commands: new URL("./commands.html", import.meta.url).pathname,
        customFunctions: new URL("./custom-functions.html", import.meta.url).pathname,
      },
    },
  },
});
