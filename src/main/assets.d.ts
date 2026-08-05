/**
 * Text files imported into the main bundle.
 *
 * `vite/client` declares this for the renderer; the main process is typechecked
 * against Node's types only, so it needs its own.
 */
declare module '*?raw' {
  const content: string
  export default content
}
