function factory(ports) {
  return function arm({ workerPid, deadlineMs, onDeadline, onUnreaped }) {
    if (!Number.isSafeInteger(workerPid) || workerPid <= 0 || !Number.isSafeInteger(deadlineMs))
      throw Error("watchdog_arguments");
    let expired = false;
    let fallback;
    const expire = () => {
      if (expired) return;
      expired = true;
      onDeadline();
      try {
        ports.kill(-workerPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          onUnreaped();
          return;
        }
      }
      // SIGKILL being queued does not prove exit. Never wait on close forever.
      fallback = ports.setTimeout(onUnreaped, 250);
    };
    const timer = ports.setTimeout(expire, Math.max(1, deadlineMs - ports.now()));
    return {
      expire,
      cancel: () => {
        ports.clearTimeout(timer);
        if (fallback !== undefined) ports.clearTimeout(fallback);
      },
    };
  };
}
export const armProducerDeadline = factory({
  now: Date.now,
  setTimeout,
  clearTimeout,
  kill: process.kill.bind(process),
});
/** Internal test seam, never selected by service arguments. */
export const createProducerDeadlineTestHarness = factory;
