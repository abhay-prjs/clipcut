// ═══════════════════════════════════════
// TERMINAL LOGGER
// ═══════════════════════════════════════
// jlog(level, msg) — sends to Python terminal via pywebview.api.log_js().
// Falls back to console when not in pywebview.
function jlog(level, msg) {
  const line = `${msg}`;
  if (window.pywebview) {
    window.pywebview.api.log_js(level, line).catch(() => {});
  } else {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[JS/${level.toUpperCase()}] ${line}`);
  }
}

// Global uncaught JS error → terminal
window.onerror = function(msg, src, line, col, err) {
  jlog('error', `Uncaught error: ${msg}`);
  jlog('error', `  at ${src}:${line}:${col}`);
  if (err && err.stack) jlog('error', `  stack: ${err.stack.split('\n').slice(0,3).join(' | ')}`);
};

// Unhandled promise rejections → terminal
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  jlog('error', `Unhandled promise rejection: ${reason?.message || reason}`);
  if (reason?.stack) jlog('error', `  stack: ${reason.stack.split('\n').slice(0,3).join(' | ')}`);
});

// Pipe console.error to terminal as well
const _origConsoleError = console.error.bind(console);
console.error = function(...args) {
  _origConsoleError(...args);
  const serialized = args.map(a => {
    if (a instanceof Error) return `${a.constructor.name}: ${a.message}${a.stack ? '\n  '+a.stack.split('\n').slice(1,4).join('\n  ') : ''}`;
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  jlog('error', serialized);
};
