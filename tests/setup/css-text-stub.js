/**
 * Jest stand-in for esbuild's `.css` text loader (see esbuild.config.mjs):
 * production imports of a .css file resolve to the file's content as a
 * string, so tests receive a non-empty placeholder string instead.
 */
module.exports = '/* css text stub */'
