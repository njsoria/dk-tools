declare module 'claude-code' {
  interface PluginState {
    // The repo's line under the prompt; null hides it.
    repoVis: { line: string | null }
  }
}
