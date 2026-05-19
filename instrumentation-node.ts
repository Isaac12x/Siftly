export async function registerNodeInstrumentation() {
  const { startScheduler } = await import('@/lib/x-sync')

  try {
    await startScheduler()
    console.log('[instrumentation] Sync scheduler initialized')
  } catch (err) {
    console.error('[instrumentation] Failed to start scheduler:', err)
  }
}
