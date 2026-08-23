/**
 * esbuild loads `.css` imports with the `text` loader (see
 * esbuild.config.mjs), so a css import resolves to the file content as a
 * string. Jest mirrors the contract via the css-text-stub module mapper.
 */
declare module '*.css' {
  const cssText: string
  export default cssText
}
