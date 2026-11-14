import { defineConfig } from "vite";

// Relative asset paths, so the build works under any sub-path, such as
// GitHub Pages' https://<user>.github.io/<repo>/.
export default defineConfig({
  base: "./",
});
