const { parentPort } = require('worker_threads');
const { loadSnapshot } = require('./codexData');

if (!parentPort) {
  throw new Error('snapshotWorker must run inside a worker thread.');
}

parentPort.on('message', async (message) => {
  const id = message && message.id;
  if (!id) return;

  try {
    const snapshot = await loadSnapshot();
    parentPort.postMessage({ id, snapshot });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        name: error && error.name ? error.name : 'Error',
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : null
      }
    });
  }
});
