const serviceNames = new Set(['auth', 'auth-tls', 'app'])
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SPAWN_ERROR'])

/** Dispose only a child retained by this owner. Never adopt or signal a PID. */
export async function stopNativeProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  let onClose
  const closed = new Promise(resolve => { onClose = resolve; proc.once('close', onClose) })
  const wait = async () => {
    let timer
    try {
      return await Promise.race([closed.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), 2000)
      })])
    } finally { clearTimeout(timer) }
  }
  try {
    try { proc.kill('SIGTERM') } catch { /* A concurrent child exit is observed below. */ }
    if (await wait()) return
    try { proc.kill('SIGKILL') } catch { /* Keep the original close observation. */ }
    if (!await wait()) throw Error('NATIVE_CHILD_CLEANUP_UNCONFIRMED')
  } finally { proc.removeListener('close', onClose) }
}

/** Required services must remain alive for the entire dependent stage. */
export async function waitForNativeStage(pending, services) {
  const observed = await Promise.race([
    Promise.resolve(pending).then(value => ({kind: 'RESULT', value})),
    ...services.map(service => service.ended.then(row => ({kind: 'SERVICE_EXIT', service, row}))),
  ])
  if (observed.kind === 'RESULT') return observed.value
  const {service, row} = observed
  const error = new Error('NATIVE_REQUIRED_SERVICE_EXITED')
  error.nativeFailure = Object.freeze({
    dependency: serviceNames.has(service.row.label) ? service.row.label : 'OTHER_REQUIRED_SERVICE',
    code: Number.isInteger(row.code) && row.code >= 0 && row.code <= 255 ? row.code : null,
    signal: signals.has(row.signal) ? row.signal : null,
    observedAt: new Date().toISOString(),
  })
  throw error
}
