export function runLegacyInit(name, ctx, init) {
  const reportHealth = ctx && ctx.reportHealth;
  const key = 'legacy.' + name;
  try {
    if (typeof reportHealth === 'function') reportHealth(key, 'starting');
    if (typeof init === 'function') init();
    if (typeof reportHealth === 'function') reportHealth(key, 'ok');
  } catch (error) {
    if (typeof reportHealth === 'function') {
      reportHealth(key, 'error', {
        message: error && error.message ? error.message : String(error),
      });
    }
    throw error;
  }
}
