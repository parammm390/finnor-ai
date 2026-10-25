export type AnalyticalExecutionMode = 'ordinary_disposable' | 'production_analysis' | 'protected';

export function analyticalExecutionCapabilities() {
  const configured = process.env.FINNOR_P4_PROFILE;
  const production = process.env.NODE_ENV === 'production' || process.env.FINNOR_ENVIRONMENT === 'production';
  const mode = configured === 'production_analysis' ? 'production_analysis'
    : configured === 'ordinary_disposable' && !production ? 'ordinary_disposable' : null;
  return {
    schema: 'finnor.analytical-execution-capabilities.v1' as const,
    mode,
    reason: mode ? null : 'ANALYTICAL_RUNTIME_PROFILE_NOT_CONFIGURED',
    effectAuthority: false,
    protectedExecution: false,
    resultQualification: 'SOURCE_BOUND_ANALYSIS_REQUIRES_INDEPENDENT_CHECKS',
  };
}

export function assertAnalyticalExecutionProfile(mode: AnalyticalExecutionMode): void {
  if (mode === 'protected') throw Error('PROTECTED_FUNDING_ADMISSION_AND_RUNTIME_BINDINGS_UNAVAILABLE');
  if (analyticalExecutionCapabilities().mode !== mode) throw Error('ANALYTICAL_RUNTIME_PROFILE_NOT_CONFIGURED');
}
