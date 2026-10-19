/** Filled in at build time by the "build-info" plugin in esbuild.config.mjs. */
declare module 'taskchute:build-info' {
  const info: {
    /** Commits in the history the plugin was built from: only ever goes up. 0 when unknown. */
    number: number
  }
  export default info
}
