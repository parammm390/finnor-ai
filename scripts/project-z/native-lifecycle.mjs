const serviceNames = new Set(['auth', 'auth-tls', 'app'])
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SPAWN_ERROR'])

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
