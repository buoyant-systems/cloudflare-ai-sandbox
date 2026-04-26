/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * This is a thin wrapper around the bridge from @cloudflare/sandbox/bridge.
 * All API routes and authentication are handled by the bridge.
 *
 * To upgrade: bump the @cloudflare/sandbox version in package.json.
 */

import { bridge } from '@cloudflare/sandbox/bridge';
import {
  handleGitClone,
  handleGitFetch,
  handleGitPull,
  handleGitPush,
} from './git';

// Re-export Sandbox so Wrangler can wire up the Durable Object binding.
export { Sandbox } from '@cloudflare/sandbox';

/** Pattern: POST /v1/sandbox/:id/git/:action */
const GIT_PATTERN = new URLPattern({ pathname: '/v1/sandbox/:id/git/:action' });

/** Sandbox ID must be base32 lowercase, 1-128 chars. */
const SANDBOX_ID_RE = /^[a-z2-7]{1,128}$/;

/** Supported git actions and their handlers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GIT_HANDLERS: Record<string, (id: string, body: any, getSandbox: (id: string) => unknown) => Promise<Response>> = {
  clone: handleGitClone,
  pull: handleGitPull,
  push: handleGitPush,
  fetch: handleGitFetch,
};

export default bridge({
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // ── POST /v1/sandbox/:id/git/:action ────────────────────────────
    if (request.method === 'POST') {
      const match = GIT_PATTERN.exec(request.url);
      if (match) {
        const sandboxId = match.pathname.groups.id ?? '';
        const action = match.pathname.groups.action ?? '';

        // Validate action
        const handler = GIT_HANDLERS[action];
        if (!handler) {
          return Response.json(
            { error: `Unknown git action: ${action}`, code: 'not_found' },
            { status: 404 }
          );
        }

        // Validate sandbox ID format
        if (!SANDBOX_ID_RE.test(sandboxId)) {
          return Response.json(
            { error: 'Invalid sandbox ID', code: 'invalid_request' },
            { status: 400 }
          );
        }

        // Authenticate — same scheme as bridge routes
        const apiKey = env.SANDBOX_API_KEY;
        if (apiKey) {
          const auth = request.headers.get('Authorization');
          if (auth !== `Bearer ${apiKey}`) {
            return Response.json(
              { error: 'Unauthorized', code: 'unauthorized' },
              { status: 401 }
            );
          }
        }

        // Parse JSON body
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: 'Invalid JSON body', code: 'invalid_request' },
            { status: 400 }
          );
        }

        // Resolve sandbox stub and call the handler
        const stubId = env.Sandbox.idFromName(sandboxId);
        const stub = env.Sandbox.get(stubId);

        return handler(sandboxId, body as never, () => stub);
      }
    }

    // Application-specific fetch handling (runs after bridge routes).
    // Return custom responses here, or remove this handler to let the
    // bridge return 404 for non-API routes.
    return new Response('OK');
  }
});
