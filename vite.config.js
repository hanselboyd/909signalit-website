import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const page = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: page("./index.html"),
        services: page("./services.html"),
        businessIt: page("./business-it.html"),
        serviceAreas: page("./service-areas.html"),
        contact: page("./contact.html")
      }
    }
  }
});
