import { cp } from "node:fs/promises";

/**
 * `tsc` compiles TypeScript but does not copy imported JSON into the output
 * directory, so a built `dist/` would fail at runtime on the mock datasets and
 * the LLM fixtures. Copy every non-TypeScript asset across after compilation.
 * Plain Node so the build stays cross-platform.
 */
await cp("src", "dist", {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
