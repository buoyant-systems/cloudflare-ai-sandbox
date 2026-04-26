/**
 * POST /v1/sandbox/:id/git/clone — Clone a private git repository into the sandbox.
 *
 * Uses an inline credential helper so the auth token is never written to disk.
 * After the git process exits, no trace of the token remains in the container —
 * not in .git/config, not in the reflog, not in env vars, not in credential stores.
 *
 * Security properties:
 *  - The clone URL is always clean (no embedded token)
 *  - Token is passed via `-c credential.helper=...` (process-scoped, ephemeral)
 *  - No env vars, no .git-credentials, no credential.helper persisted in config
 *  - Path is validated to resolve within /workspace (same as /exec)
 */


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitCloneRequest {
  /** HTTPS URL of the repository to clone. */
  url: string;
  /** Authentication token (e.g. GitHub PAT, fine-grained token, GitLab token). */
  token: string;
  /** Destination path inside the sandbox. Defaults to repo name under /workspace. */
  path?: string;
  /** Branch to checkout after clone. */
  branch?: string;
  /** Shallow clone depth. */
  depth?: number;
  /** Username for HTTPS auth. Defaults to "x-access-token" (GitHub convention). */
  tokenUser?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = '/workspace';

/**
 * Resolve a path relative to /workspace and verify it stays within bounds.
 * Returns the resolved absolute path or null if it escapes /workspace.
 */
function resolveWorkspacePath(raw: string): string | null {
  // Resolve relative paths against /workspace
  const resolved = raw.startsWith('/')
    ? normalizePosixPath(raw)
    : normalizePosixPath(`${WORKSPACE_ROOT}/${raw}`);

  if (resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return resolved;
  }
  return null;
}

/** Normalize a POSIX path by resolving `.` and `..` segments. */
function normalizePosixPath(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

/**
 * Derive a default clone destination from the repo URL.
 * e.g. "https://github.com/org/my-repo.git" → "/workspace/my-repo"
 */
function defaultClonePath(repoUrl: string): string {
  const urlPath = new URL(repoUrl).pathname;
  const basename = urlPath.split('/').pop() ?? 'repo';
  const name = basename.replace(/\.git$/, '') || 'repo';
  return `${WORKSPACE_ROOT}/${name}`;
}

/**
 * Shell-quote a string using $'...' syntax. Escapes single quotes, backslashes,
 * and control characters. This mirrors the shellQuote() used by the bridge /exec route.
 */
function shellQuote(s: string): string {
  // If the string is safe (alphanumeric, hyphens, underscores, dots, slashes,
  // equals, colons, at-signs), return it unquoted.
  if (/^[a-zA-Z0-9_.\/=:@-]+$/.test(s)) {
    return s;
  }

  // Use $'...' quoting which handles all special characters.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  return `$'${escaped}'`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationError {
  status: number;
  code: string;
  error: string;
}

function validateRequest(body: GitCloneRequest): ValidationError | null {
  if (!body.url || typeof body.url !== 'string') {
    return { status: 400, code: 'invalid_request', error: 'url is required and must be a string' };
  }

  // Only allow HTTPS URLs — no git://, ssh://, file://
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return { status: 400, code: 'invalid_request', error: 'url must be a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { status: 400, code: 'invalid_request', error: 'url must use the https:// protocol' };
  }

  // Reject URLs that already have credentials embedded
  if (parsed.username || parsed.password) {
    return {
      status: 400,
      code: 'invalid_request',
      error: 'url must not contain embedded credentials — pass them via the token field'
    };
  }

  if (!body.token || typeof body.token !== 'string') {
    return { status: 400, code: 'invalid_request', error: 'token is required and must be a non-empty string' };
  }

  if (body.path !== undefined) {
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return { status: 400, code: 'invalid_request', error: 'path must be a non-empty string when provided' };
    }
    const resolved = resolveWorkspacePath(body.path);
    if (!resolved) {
      return {
        status: 403,
        code: 'invalid_request',
        error: 'path must resolve to a location within /workspace'
      };
    }
  }

  if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch.trim() === '')) {
    return { status: 400, code: 'invalid_request', error: 'branch must be a non-empty string when provided' };
  }

  if (body.depth !== undefined) {
    if (typeof body.depth !== 'number' || !Number.isInteger(body.depth) || body.depth < 1) {
      return { status: 400, code: 'invalid_request', error: 'depth must be a positive integer' };
    }
  }

  if (body.tokenUser !== undefined && (typeof body.tokenUser !== 'string' || body.tokenUser.trim() === '')) {
    return { status: 400, code: 'invalid_request', error: 'tokenUser must be a non-empty string when provided' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

/**
 * Build the `git clone` command string with an inline credential helper.
 *
 * The credential helper is a shell function passed via `-c credential.helper=...`.
 * It echoes the username and password when git requests authentication.
 * The token is only visible as a process argument — it never touches disk.
 */
function buildCloneCommand(body: GitCloneRequest): { cmd: string; destPath: string } {
  const tokenUser = body.tokenUser ?? 'x-access-token';
  const destPath = body.path
    ? (resolveWorkspacePath(body.path) as string) // already validated
    : defaultClonePath(body.url);

  // Build the inline credential helper.
  // The helper is a shell function that prints the protocol/host/username/password
  // in the format git expects from a credential helper.
  //
  // We use $'...' quoting for the token to handle special characters safely.
  const quotedUser = shellQuote(tokenUser);
  const quotedToken = shellQuote(body.token);

  // The credential helper must output key=value pairs on stdout.
  // Using printf to avoid issues with echo and backslash interpretation.
  const helper = `!f() { printf 'username=%s\\npassword=%s\\n' ${quotedUser} ${quotedToken}; }; f`;

  // Build the full command
  const parts = [
    'git',
    '-c', shellQuote(`credential.helper=${helper}`),
    'clone'
  ];

  if (body.branch) {
    parts.push('--branch', shellQuote(body.branch));
  }

  if (body.depth) {
    parts.push('--depth', String(body.depth));
  }

  parts.push(shellQuote(body.url));
  parts.push(shellQuote(destPath));

  return { cmd: parts.join(' '), destPath };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle POST /v1/sandbox/:id/git/clone.
 *
 * Expects the Hono context to have the sandbox available via getSandbox().
 * This function is designed to be called from the worker's custom fetch handler.
 */
export async function handleGitClone(
  sandboxId: string,
  body: GitCloneRequest,
  getSandbox: (id: string) => unknown
): Promise<Response> {
  // Validate input
  const validationError = validateRequest(body);
  if (validationError) {
    return Response.json(
      { error: validationError.error, code: validationError.code },
      { status: validationError.status }
    );
  }

  // Build the clone command
  const { cmd, destPath } = buildCloneCommand(body);

  try {
    // Get the sandbox instance and execute the clone
    const sandbox = getSandbox(sandboxId) as {
      exec: (cmd: string, opts?: Record<string, unknown>) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    };

    const result = await sandbox.exec(cmd, {
      timeout: 120_000, // 2 minutes — large repos may take a while
      cwd: WORKSPACE_ROOT
    });

    if (result.exitCode !== 0) {
      // Sanitize stderr to ensure the token doesn't leak in error messages.
      // The credential helper approach shouldn't leak, but belt-and-suspenders.
      const sanitizedStderr = sanitizeOutput(result.stderr, body.token);
      return Response.json(
        {
          error: `git clone failed (exit code ${result.exitCode}): ${sanitizedStderr}`,
          code: 'clone_error'
        },
        { status: 502 }
      );
    }

    return Response.json({ ok: true, path: destPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sanitized = sanitizeOutput(message, body.token);
    return Response.json(
      { error: sanitized, code: 'clone_error' },
      { status: 502 }
    );
  }
}

/**
 * Scrub the token from any output string, just in case git somehow
 * echoes it back in an error message.
 */
function sanitizeOutput(output: string, token: string): string {
  if (!token) return output;
  // Replace all occurrences of the token with [REDACTED]
  return output.split(token).join('[REDACTED]');
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export {
  resolveWorkspacePath,
  defaultClonePath,
  buildCloneCommand,
  validateRequest,
  sanitizeOutput,
  shellQuote
};
export type { GitCloneRequest, ValidationError };
