// A log that survives the crash that wrote it.
//
// THE REASON THIS EXISTS. A recording session crashed the app on device, and there
// was nothing to look at: no crash reporting of any kind, and `<Camera>`'s onError
// defaulting to console.error — which on a device nobody has attached to Xcode is
// the same as silence. The diagnosis that followed was three hypotheses and no
// evidence, which is the expensive way to work.
//
// WHAT THIS CAN AND CANNOT CATCH, stated plainly so it is not trusted too far:
//
//   CAN   JS exceptions, unhandled promise rejections, and anything reported
//         through a native module's error callback — including camera session
//         errors, which frequently PRECEDE a native crash and name its cause.
//   CANNOT A hard native crash. When Swift traps, the process is gone before any
//         JS runs. Only the iOS crash report (.ips) has that, and this file does
//         not pretend otherwise.
//
// So this is not a crash reporter. It is the record of what the app was saying just
// before it died, which is usually the part that identifies the bug.
//
// Written to the DOCUMENT directory, not the cache: the whole point is that it
// outlives the process, and iOS evicts caches under exactly the storage pressure a
// video app creates.

import { Directory, File, Paths } from 'expo-file-system';

const DIR = 'diag';
const FILE = 'events.log';

/**
 * Bytes kept. Small on purpose — this is read by a person on a phone, and an
 * unbounded log on a device with a storage guard is its own bug.
 */
const MAX_BYTES = 64 * 1024;

function logFile(): File {
  const dir = new Directory(Paths.document, DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, FILE);
}

/**
 * Append one line. NEVER throws.
 *
 * A logger that can fail the thing it is logging is worse than no logger — and this
 * runs from a global error handler, where a throw would replace the original error
 * with its own.
 */
export function logEvent(tag: string, message: string): void {
  try {
    const line = `${new Date().toISOString()} [${tag}] ${message}\n`;
    const f = logFile();
    const existing = f.exists ? f.textSync() : '';
    // Trim from the FRONT: the newest lines are the ones that explain a crash.
    const next = (existing + line).slice(-MAX_BYTES);
    f.write(next);
  } catch {
    // Nothing to do and nowhere to say it.
  }
}

export function readLog(): string {
  try {
    const f = logFile();
    return f.exists ? f.textSync() : '';
  } catch {
    return '';
  }
}

export function clearLog(): void {
  try {
    const f = logFile();
    if (f.exists) f.write('');
  } catch {
    // Same as above.
  }
}

/** RN's global handler hook. Typed here rather than reaching for `any` at the site. */
type ErrorUtilsShape = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (h: (error: unknown, isFatal?: boolean) => void) => void;
};

const describe = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? '(no stack)'}` : String(e);

let installed = false;

/**
 * Install the handlers. Idempotent, and CHAINS rather than replaces.
 *
 * Chaining is the part that matters: RN's own handler is what shows the red screen
 * in development and what reports the error onward. Replacing it would trade a
 * visible failure for a logged one, which is a worse deal than it sounds — the log
 * is only read when someone already suspects something.
 */
export function installCrashLog(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as { ErrorUtils?: ErrorUtilsShape };
  const eu = g.ErrorUtils;
  if (eu?.setGlobalHandler) {
    const previous = eu.getGlobalHandler?.();
    eu.setGlobalHandler((error, isFatal) => {
      logEvent(isFatal ? 'FATAL' : 'ERROR', describe(error));
      previous?.(error, isFatal);
    });
  }

  // Unhandled rejections are the ones this app is most likely to produce: every
  // probe, seek and import is a promise, and a screen that fires one without
  // awaiting it has no other way to report a failure.
  const withTracking = globalThis as unknown as {
    addEventListener?: (t: string, h: (e: { reason?: unknown }) => void) => void;
  };
  withTracking.addEventListener?.('unhandledrejection', (e) => {
    logEvent('REJECTION', describe(e?.reason));
  });

  logEvent('START', 'app launched');
}
