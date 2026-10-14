declare module 'claude-code' {
  interface PluginState {
    // The router's line under the prompt; null hides it.
    'kore-model-router': { line: string | null }
  }
}
