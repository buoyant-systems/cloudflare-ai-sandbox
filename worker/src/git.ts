/**
 * Git operations for the sandbox bridge.
 *
 * Endpoints: clone, pull, push, fetch — all with ephemeral credential injection.
 *
 * Uses an inline credential helper so the auth token is never written to disk.
 * After each git process exits, no trace of the token remains in the container —
 * not in .git/config, not in the reflog, not in env vars, not in credential stores.
 *
 * Security properties:
 *  - Token is passed via `-c credential.helper=...` (process-scoped, ephemeral)
 *  - No env vars, no .git-credentials, no credential.helper persisted in config
 *  - All paths validated to resolve within /workspace
 *  - Error output is sanitized to strip the token before returning to the caller
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Fields common to every git operation that needs remote auth. */
interface GitCredentials {
  /** Authentication token (e.g. GitHub PAT, fine-grained token, GitLab token). */
  token: string;
  /** Username for HTTPS auth. Defaults to "x-access-token" (GitHub convention). */
  tokenUser?: string;
}

export interface GitCloneRequest extends GitCredentials {
  /** HTTPS URL of the repository to clone. */
  url: string;
  /** Destination path inside the sandbox. Defaults to repo name under /workspace. */
  path?: string;
  /** Branch to checkout after clone. */
  branch?: string;
  /** Shallow clone depth. */
  depth?: number;
}

export interface GitPullRequest extends GitCredentials {
  /** Path to the git repository inside the sandbox. */
  path: string;
  /** Remote name. Defaults to "origin". */
  remote?: string;
  /** Branch to pull. */
  branch?: string;
  /** Force-update local refs even when the update is not a fast-forward. */
  force?: boolean;
  /** Rebase local commits on top of the fetched branch instead of merging. */
  rebase?: boolean;
}

export interface GitPushRequest extends GitCredentials {
  /** Path to the git repository inside the sandbox. */
  path: string;
  /** Remote name. Defaults to "origin". */
  remote?: string;
  /** Branch to push. */
  branch?: string;
  /** Force-push (overwrites remote history). */
  force?: boolean;
}

export interface GitFetchRequest extends GitCredentials {
  /** Path to the git repository inside the sandbox. */
  path: string;
  /** Remote name. Defaults to "origin". */
  remote?: string;
  /** Branch/refspec to fetch. */
  branch?: string;
  /** Remove remote-tracking refs that no longer exist on the remote. */
  prune?: boolean;
  /** Shallow clone depth limit. */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ValidationError {
  status: number;
  code: string;
  error: string;
}

interface SandboxLike {
  exec: (cmd: string, opts?: Record<string, unknown>) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers (shared across operations)
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = '/workspace';

/**
 * Resolve a path relative to /workspace and verify it stays within bounds.
 * Returns the resolved absolute path or null if it escapes /workspace.
 */
export function resolveWorkspacePath(raw: string): string | null {
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
export function defaultClonePath(repoUrl: string): string {
  const urlPath = new URL(repoUrl).pathname;
  const basename = urlPath.split('/').pop() ?? 'repo';
  const name = basename.replace(/\.git$/, '') || 'repo';
  return `${WORKSPACE_ROOT}/${name}`;
}

/**
 * Shell-quote a string using $'...' syntax. Escapes single quotes, backslashes,
 * and control characters. Mirrors the shellQuote() used by the bridge /exec route.
 */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_.\/=:@-]+$/.test(s)) {
    return s;
  }
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `$'${escaped}'`;
}

/**
 * Scrub the token from any output string, just in case git somehow
 * echoes it back in an error message.
 */
export function sanitizeOutput(output: string, token: string): string {
  if (!token) return output;
  return output.split(token).join('[REDACTED]');
}

/**
 * Build the `-c credential.helper=...` argument for git.
 * The helper is an inline shell function that prints credentials on stdout.
 */
function credentialHelperArg(token: string, tokenUser = 'x-access-token'): string {
  const quotedUser = shellQuote(tokenUser);
  const quotedToken = shellQuote(token);
  const helper = `!f() { printf 'username=%s\\npassword=%s\\n' ${quotedUser} ${quotedToken}; }; f`;
  return shellQuote(`credential.helper=${helper}`);
}

// ---------------------------------------------------------------------------
// Validation — shared
// ---------------------------------------------------------------------------

function validateCredentials(body: GitCredentials): ValidationError | null {
  if (!body.token || typeof body.token !== 'string') {
    return { status: 400, code: 'invalid_request', error: 'token is required and must be a non-empty string' };
  }
  if (body.tokenUser !== undefined && (typeof body.tokenUser !== 'string' || body.tokenUser.trim() === '')) {
    return { status: 400, code: 'invalid_request', error: 'tokenUser must be a non-empty string when provided' };
  }
  return null;
}

/** Validate a required repo path field (used by pull/push/fetch). */
function validateRepoPath(path: unknown): ValidationError | null {
  if (!path || typeof path !== 'string' || (path as string).trim() === '') {
    return { status: 400, code: 'invalid_request', error: 'path is required and must point to a git repository within /workspace' };
  }
  const resolved = resolveWorkspacePath(path as string);
  if (!resolved) {
    return { status: 403, code: 'invalid_request', error: 'path must resolve to a location within /workspace' };
  }
  return null;
}

function validateOptionalBranch(branch: unknown): ValidationError | null {
  if (branch !== undefined && (typeof branch !== 'string' || (branch as string).trim() === '')) {
    return { status: 400, code: 'invalid_request', error: 'branch must be a non-empty string when provided' };
  }
  return null;
}

function validateOptionalRemote(remote: unknown): ValidationError | null {
  if (remote !== undefined && (typeof remote !== 'string' || (remote as string).trim() === '')) {
    return { status: 400, code: 'invalid_request', error: 'remote must be a non-empty string when provided' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation — per operation
// ---------------------------------------------------------------------------

export function validateCloneRequest(body: GitCloneRequest): ValidationError | null {
  if (!body.url || typeof body.url !== 'string') {
    return { status: 400, code: 'invalid_request', error: 'url is required and must be a string' };
  }
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return { status: 400, code: 'invalid_request', error: 'url must be a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { status: 400, code: 'invalid_request', error: 'url must use the https:// protocol' };
  }
  if (parsed.username || parsed.password) {
    return { status: 400, code: 'invalid_request', error: 'url must not contain embedded credentials — pass them via the token field' };
  }

  let err = validateCredentials(body);
  if (err) return err;

  if (body.path !== undefined) {
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return { status: 400, code: 'invalid_request', error: 'path must be a non-empty string when provided' };
    }
    const resolved = resolveWorkspacePath(body.path);
    if (!resolved) {
      return { status: 403, code: 'invalid_request', error: 'path must resolve to a location within /workspace' };
    }
  }

  err = validateOptionalBranch(body.branch);
  if (err) return err;

  if (body.depth !== undefined) {
    if (typeof body.depth !== 'number' || !Number.isInteger(body.depth) || body.depth < 1) {
      return { status: 400, code: 'invalid_request', error: 'depth must be a positive integer' };
    }
  }

  return null;
}

export function validatePullRequest(body: GitPullRequest): ValidationError | null {
  let err = validateRepoPath(body.path);
  if (err) return err;
  err = validateCredentials(body);
  if (err) return err;
  err = validateOptionalRemote(body.remote);
  if (err) return err;
  err = validateOptionalBranch(body.branch);
  if (err) return err;
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    return { status: 400, code: 'invalid_request', error: 'force must be a boolean' };
  }
  if (body.rebase !== undefined && typeof body.rebase !== 'boolean') {
    return { status: 400, code: 'invalid_request', error: 'rebase must be a boolean' };
  }
  return null;
}

export function validatePushRequest(body: GitPushRequest): ValidationError | null {
  let err = validateRepoPath(body.path);
  if (err) return err;
  err = validateCredentials(body);
  if (err) return err;
  err = validateOptionalRemote(body.remote);
  if (err) return err;
  err = validateOptionalBranch(body.branch);
  if (err) return err;
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    return { status: 400, code: 'invalid_request', error: 'force must be a boolean' };
  }
  return null;
}

export function validateFetchRequest(body: GitFetchRequest): ValidationError | null {
  let err = validateRepoPath(body.path);
  if (err) return err;
  err = validateCredentials(body);
  if (err) return err;
  err = validateOptionalRemote(body.remote);
  if (err) return err;
  err = validateOptionalBranch(body.branch);
  if (err) return err;
  if (body.prune !== undefined && typeof body.prune !== 'boolean') {
    return { status: 400, code: 'invalid_request', error: 'prune must be a boolean' };
  }
  if (body.depth !== undefined) {
    if (typeof body.depth !== 'number' || !Number.isInteger(body.depth) || body.depth < 1) {
      return { status: 400, code: 'invalid_request', error: 'depth must be a positive integer' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export function buildCloneCommand(body: GitCloneRequest): { cmd: string; destPath: string } {
  const destPath = body.path
    ? (resolveWorkspacePath(body.path) as string)
    : defaultClonePath(body.url);

  const parts = ['git', '-c', credentialHelperArg(body.token, body.tokenUser), 'clone'];

  if (body.branch) parts.push('--branch', shellQuote(body.branch));
  if (body.depth) parts.push('--depth', String(body.depth));

  parts.push(shellQuote(body.url));
  parts.push(shellQuote(destPath));

  return { cmd: parts.join(' '), destPath };
}

export function buildPullCommand(body: GitPullRequest): { cmd: string; repoPath: string } {
  const repoPath = resolveWorkspacePath(body.path) as string;
  const parts = ['git', '-c', credentialHelperArg(body.token, body.tokenUser), 'pull'];

  if (body.force) parts.push('--force');
  if (body.rebase) parts.push('--rebase');

  parts.push(shellQuote(body.remote ?? 'origin'));
  if (body.branch) parts.push(shellQuote(body.branch));

  return { cmd: parts.join(' '), repoPath };
}

export function buildPushCommand(body: GitPushRequest): { cmd: string; repoPath: string } {
  const repoPath = resolveWorkspacePath(body.path) as string;
  const parts = ['git', '-c', credentialHelperArg(body.token, body.tokenUser), 'push'];

  if (body.force) parts.push('--force');

  parts.push(shellQuote(body.remote ?? 'origin'));
  if (body.branch) parts.push(shellQuote(body.branch));

  return { cmd: parts.join(' '), repoPath };
}

export function buildFetchCommand(body: GitFetchRequest): { cmd: string; repoPath: string } {
  const repoPath = resolveWorkspacePath(body.path) as string;
  const parts = ['git', '-c', credentialHelperArg(body.token, body.tokenUser), 'fetch'];

  if (body.prune) parts.push('--prune');
  if (body.depth) parts.push('--depth', String(body.depth));

  parts.push(shellQuote(body.remote ?? 'origin'));
  if (body.branch) parts.push(shellQuote(body.branch));

  return { cmd: parts.join(' '), repoPath };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Execute a git command in the sandbox and return a sanitized JSON response. */
async function execGit(
  sandbox: SandboxLike,
  cmd: string,
  cwd: string,
  token: string,
  operation: string
): Promise<Response> {
  try {
    const result = await sandbox.exec(cmd, {
      timeout: 120_000,
      cwd
    });

    if (result.exitCode !== 0) {
      const sanitizedStderr = sanitizeOutput(result.stderr, token);
      return Response.json(
        { error: `git ${operation} failed (exit code ${result.exitCode}): ${sanitizedStderr}`, code: `${operation}_error` },
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      stdout: sanitizeOutput(result.stdout, token),
      stderr: sanitizeOutput(result.stderr, token)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: sanitizeOutput(message, token), code: `${operation}_error` },
      { status: 502 }
    );
  }
}

export async function handleGitClone(
  _sandboxId: string,
  body: GitCloneRequest,
  getSandbox: (id: string) => unknown
): Promise<Response> {
  const validationError = validateCloneRequest(body);
  if (validationError) {
    return Response.json(
      { error: validationError.error, code: validationError.code },
      { status: validationError.status }
    );
  }

  const { cmd, destPath } = buildCloneCommand(body);
  const sandbox = getSandbox(_sandboxId) as SandboxLike;

  try {
    const result = await sandbox.exec(cmd, { timeout: 120_000, cwd: WORKSPACE_ROOT });

    if (result.exitCode !== 0) {
      const sanitizedStderr = sanitizeOutput(result.stderr, body.token);
      return Response.json(
        { error: `git clone failed (exit code ${result.exitCode}): ${sanitizedStderr}`, code: 'clone_error' },
        { status: 502 }
      );
    }

    return Response.json({ ok: true, path: destPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: sanitizeOutput(message, body.token), code: 'clone_error' },
      { status: 502 }
    );
  }
}

export async function handleGitPull(
  _sandboxId: string,
  body: GitPullRequest,
  getSandbox: (id: string) => unknown
): Promise<Response> {
  const validationError = validatePullRequest(body);
  if (validationError) {
    return Response.json(
      { error: validationError.error, code: validationError.code },
      { status: validationError.status }
    );
  }

  const { cmd, repoPath } = buildPullCommand(body);
  const sandbox = getSandbox(_sandboxId) as SandboxLike;
  return execGit(sandbox, cmd, repoPath, body.token, 'pull');
}

export async function handleGitPush(
  _sandboxId: string,
  body: GitPushRequest,
  getSandbox: (id: string) => unknown
): Promise<Response> {
  const validationError = validatePushRequest(body);
  if (validationError) {
    return Response.json(
      { error: validationError.error, code: validationError.code },
      { status: validationError.status }
    );
  }

  const { cmd, repoPath } = buildPushCommand(body);
  const sandbox = getSandbox(_sandboxId) as SandboxLike;
  return execGit(sandbox, cmd, repoPath, body.token, 'push');
}

export async function handleGitFetch(
  _sandboxId: string,
  body: GitFetchRequest,
  getSandbox: (id: string) => unknown
): Promise<Response> {
  const validationError = validateFetchRequest(body);
  if (validationError) {
    return Response.json(
      { error: validationError.error, code: validationError.code },
      { status: validationError.status }
    );
  }

  const { cmd, repoPath } = buildFetchCommand(body);
  const sandbox = getSandbox(_sandboxId) as SandboxLike;
  return execGit(sandbox, cmd, repoPath, body.token, 'fetch');
}
