// Minimal HTTP client for the scripts, no dependencies.
import http from 'node:http';
import https from 'node:https';

// --name value flags plus positional args
export function cli(args) {
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(args[i + 1]);
  };
  const positional = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
  return { positional, flag };
}

export function createClient(baseUrl, { maxSockets = 100 } = {}) {
  const base = new URL(baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets });

  // never throws; status 0 means the request itself failed (reset, timeout, ...)
  function call(method, path, { token, body, headers } = {}) {
    return new Promise((resolve) => {
      const req = lib.request(
        {
          agent,
          method,
          hostname: base.hostname,
          port: base.port,
          path,
          headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString());
            } catch {
              // not json
            }
            resolve({ status: res.statusCode, body: parsed, headers: res.headers });
          });
        },
      );
      req.on('error', () => resolve({ status: 0, body: null, headers: {} }));
      req.setTimeout(120000, () => req.destroy(new Error('timed out'))); // a hung request must not hang the script
      req.end(body && JSON.stringify(body));
    });
  }

  const tokenFor = async (userId, adminKey) =>
    (await call('POST', '/auth/token', { body: { user_id: userId, admin_key: adminKey } })).body?.token;

  return { base, call, tokenFor };
}
