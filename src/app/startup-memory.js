const MIB = 1024 * 1024;

// V8's heap is only part of RSS; leave room for Discord, SQLite, buffers and the runtime.
export function hostingNodeOptions({
  platform = process.platform,
  constrainedBytes = process.constrainedMemory?.() || 0,
  nodeOptions = process.env.NODE_OPTIONS || '',
  execArgv = process.execArgv,
} = {}) {
  const memoryMiB = Math.floor(constrainedBytes / MIB);
  if (
    platform !== 'linux' ||
    memoryMiB < 128 ||
    memoryMiB > 256 ||
    /--max[-_]old[-_]space[-_]size(?:[\s=]|$)/.test(`${nodeOptions} ${execArgv.join(' ')}`)
  )
    return nodeOptions;
  const defaults = [`--max-old-space-size=${Math.floor(memoryMiB / 2)}`];
  if (!/--max[-_]semi[-_]space[-_]size(?:[\s=]|$)/.test(`${nodeOptions} ${execArgv.join(' ')}`))
    defaults.push('--max-semi-space-size=4');
  return [nodeOptions, ...defaults].filter(Boolean).join(' ');
}
