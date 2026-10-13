export const nativeFailureStages = ['snapshot', 'collector', 'process', 'acknowledgement'];
const nodeCodes = ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE'];
const signals = ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGHUP'];
export const nativeFailureFields = ['schema', 'at', 'jobId', 'version', 'stage', 'nodeCode', 'exitCode', 'signal', 'killed', 'stdoutCapturedBytes', 'stderrCapturedBytes', 'outputCapped', 'elapsedMs', 'sdkPhase', 'httpStatus'];
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
export function validateNativeFailure(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== nativeFailureFields.length || Object.keys(value).some(k => !nativeFailureFields.includes(k)) || value.schema !== 1 || !integer(value.at, now + 60000) || (typeof value.jobId !== 'string' || !/^[a-f0-9]{64}$/.test(value.jobId)) || (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)) || !nativeFailureStages.includes(value.stage) || value.nodeCode !== null && !nodeCodes.includes(value.nodeCode) || value.exitCode !== null && !integer(value.exitCode, 4294967295) || value.signal !== null && !signals.includes(value.signal) || value.killed !== null && typeof value.killed !== 'boolean' || value.outputCapped !== null && typeof value.outputCapped !== 'boolean' || !['unknown', 'conversion', 'flush'].includes(value.sdkPhase) || value.httpStatus !== null && (!integer(value.httpStatus, 599) || value.httpStatus < 400)) throw new Error('Invalid native failure receipt');
  for (const key of ['stdoutCapturedBytes', 'stderrCapturedBytes', 'elapsedMs']) if (value[key] !== null && !integer(value[key], Number.MAX_SAFE_INTEGER)) throw new Error('Invalid native failure receipt');
  return value;
}

// Only fixed logger markers and bounded typed fields survive; raw diagnostics never leave memory.
export function captureProcessFailure(error, stdout, stderr, elapsedMs) {
  const phase = typeof stderr === 'string' && /^\[langfuse-codex\] failed to convert rollout:/m.test(stderr) ? 'conversion' : typeof stderr === 'string' && /^\[langfuse-codex\] error during flush\/shutdown:/m.test(stderr) ? 'flush' : 'unknown';
  const status = phase === 'flush' && /OTLPExporterError/.test(stderr) ? /^\s+code:\s*([45][0-9]{2}),?\s*$/m.exec(stderr)?.[1] : undefined;
  return {
    nodeCode: nodeCodes.includes(error?.code) ? error.code : null,
    exitCode: integer(error?.code, 4294967295) ? error.code : null,
    signal: signals.includes(error?.signal) ? error.signal : null,
    killed: typeof error?.killed === 'boolean' ? error.killed : null,
    stdoutCapturedBytes: typeof stdout === 'string' || Buffer.isBuffer(stdout) ? Buffer.byteLength(stdout) : null,
    stderrCapturedBytes: typeof stderr === 'string' || Buffer.isBuffer(stderr) ? Buffer.byteLength(stderr) : null,
    outputCapped: typeof error?.code === 'string' || Number.isInteger(error?.code) ? error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : null,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : null,
    sdkPhase: phase, httpStatus: status ? Number(status) : null
  };
}

export function nativeFailureReceipt(error, stage, jobId, version) {
  const process = error?.nativeProcessFailure;
  const fields = captureProcessFailure(error);
  if (stage === 'process' && process) for (const key of Object.keys(fields)) {
    if (process[key] !== undefined) fields[key] = process[key];
  }
  const receipt = { schema: 1, at: Date.now(), jobId, version, stage, ...fields };
  try { return validateNativeFailure(receipt); }
  catch { return validateNativeFailure({ schema: 1, at: Date.now(), jobId, version, stage, ...captureProcessFailure(error) }); }
}
