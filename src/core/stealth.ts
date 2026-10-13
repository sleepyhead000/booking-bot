/**
 * Stealth init script.
 *
 * Injected into every page *before* any site script runs (via
 * `context.addInitScript`). Its job is to remove the cheap, well-known tells
 * that flag a stock Playwright/Chromium instance:
 *
 *   - `navigator.webdriver === true` (set by CDP automation)
 *   - missing `window.chrome` runtime object
 *   - zero plugins (headless shells report none)
 *   - `navigator.permissions.query` throwing for notifications
 *   - platform/UA mismatches and a short Error.stackTraceLimit
 *
 * It deliberately does NOT touch IP reputation or TLS fingerprints — those are
 * handled by proxy config and (optionally) rebrowser-patches. See README.
 *
 * Everything is wrapped defensively: a single illegal invocation must never
 * abort the script halfway, or the later patches silently stop applying.
 */
export const STEALTH_INIT_SCRIPT = `(() => {
  'use strict';

  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, {
        get: () => value,
        configurable: true,
        enumerable: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  // --- navigator.webdriver -------------------------------------------------
  define(Navigator.prototype, 'webdriver', undefined);

  // --- window.chrome -------------------------------------------------------
  if (!('chrome' in window)) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  } else if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }

  // --- platform consistent with the spoofed UA -----------------------------
  try {
    define(Navigator.prototype, 'platform', __STEALTH_PLATFORM__);
  } catch {
    /* ignore */
  }

  // --- languages / plugins -------------------------------------------------
  // Read from the *instance*, never from the prototype: calling a platform
  // accessor with the prototype as \`this\` throws Illegal invocation.
  try {
    if (navigator.languages && navigator.languages.length > 0) {
      define(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));
    }
  } catch {
    /* ignore */
  }

  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      const fake = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: '' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
      ];
      // Shadow on both the prototype and the instance — whichever one the
      // runtime honours is the one the detector will see.
      define(Navigator.prototype, 'plugins', fake);
      define(navigator, 'plugins', fake);
    }
  } catch {
    /* ignore */
  }

  // --- permissions.query must not throw for "notifications" ---------------
  try {
    const perms = navigator.permissions;
    const origQuery = perms && perms.query && perms.query.bind(perms);
    if (origQuery) {
      perms.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
  } catch {
    /* ignore */
  }

  // --- webdriver flag on document -----------------------------------------
  try {
    Object.defineProperty(document, 'webdriver', { get: () => undefined, configurable: true });
  } catch {
    /* ignore */
  }

  // --- stack trace parity with real Chrome ---------------------------------
  try {
    if (typeof Error.stackTraceLimit === 'number' && Error.stackTraceLimit < 40) {
      Error.stackTraceLimit = 40;
    }
  } catch {
    /* ignore */
  }

  // --- Function.prototype.toString must not reveal patched functions -------
  try {
    const origToString = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      if (this === Function.prototype.toString) return 'function toString() { [native code] }';
      return origToString.call(this);
    };
  } catch {
    /* ignore */
  }

  // --- canvas: stable per-session offset, not random noise -----------------
  // Random noise is itself a fingerprint; a deterministic daily offset is not.
  try {
    const seed = Math.floor(Date.now() / 86400000) % 256;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const w = Math.min(this.width, 16);
          const h = Math.min(this.height, 16);
          const img = ctx.getImageData(0, 0, w, h);
          for (let i = 0; i < img.data.length; i += 4) {
            img.data[i] = (img.data[i] + seed) % 256;
          }
          ctx.putImageData(img, 0, 0);
        }
      } catch {
        /* tainted canvas — fall through */
      }
      return origToDataURL.apply(this, args);
    };
  } catch {
    /* ignore */
  }
})();`;

/** Navigator.platform values that match a real Chrome on each OS. */
const PLATFORM_BY_OS: Record<string, string> = {
  win32: 'Win32',
  darwin: 'MacIntel',
  linux: 'Linux x86_64',
};

/** Build the init script with the platform baked in. */
export function stealthScript(platform: NodeJS.Platform = process.platform): string {
  const value = PLATFORM_BY_OS[platform] ?? 'Win32';
  return STEALTH_INIT_SCRIPT.replace('__STEALTH_PLATFORM__', JSON.stringify(value));
}
