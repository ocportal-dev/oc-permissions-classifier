// opencode2 loads a configured local plugin from a directory's `index.ts`, so this
// shim lets `"package": "/abs/path/to/this/repo"` work with no build step. It is
// excluded from `dist` (rootDir is ./src) and from npm (see the `files` field).
export { default } from "./src/index.ts"
