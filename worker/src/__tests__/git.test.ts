import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCloneCommand,
  buildFetchCommand,
  buildPullCommand,
  buildPushCommand,
  defaultClonePath,
  handleGitClone,
  handleGitFetch,
  handleGitPull,
  handleGitPush,
  resolveWorkspacePath,
  sanitizeOutput,
  shellQuote,
  validateCloneRequest,
  validateFetchRequest,
  validatePullRequest,
  validatePushRequest,
} from '../git';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe('resolveWorkspacePath', () => {
  it('resolves absolute paths within /workspace', () => {
    expect(resolveWorkspacePath('/workspace/repo')).toBe('/workspace/repo');
  });
  it('resolves relative paths against /workspace', () => {
    expect(resolveWorkspacePath('repo')).toBe('/workspace/repo');
  });
  it('accepts /workspace itself', () => {
    expect(resolveWorkspacePath('/workspace')).toBe('/workspace');
  });
  it('rejects paths that escape /workspace', () => {
    expect(resolveWorkspacePath('/workspace/../../etc')).toBeNull();
  });
  it('rejects paths outside /workspace', () => {
    expect(resolveWorkspacePath('/tmp/repo')).toBeNull();
  });
  it('normalizes dot segments', () => {
    expect(resolveWorkspacePath('/workspace/./src/../repo')).toBe('/workspace/repo');
  });
});

describe('defaultClonePath', () => {
  it('extracts repo name from GitHub URL', () => {
    expect(defaultClonePath('https://github.com/org/my-repo.git')).toBe('/workspace/my-repo');
  });
  it('handles URL without .git suffix', () => {
    expect(defaultClonePath('https://github.com/org/my-repo')).toBe('/workspace/my-repo');
  });
  it('falls back to "repo" for empty basename', () => {
    expect(defaultClonePath('https://github.com/')).toBe('/workspace/repo');
  });
});

describe('shellQuote', () => {
  it('returns safe strings unquoted', () => {
    expect(shellQuote('hello')).toBe('hello');
    expect(shellQuote('/workspace/repo')).toBe('/workspace/repo');
  });
  it('quotes strings with spaces', () => {
    expect(shellQuote('hello world')).toBe("$'hello world'");
  });
  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("$'it\\'s'");
  });
  it('escapes backslashes', () => {
    expect(shellQuote('a\\b')).toBe("$'a\\\\b'");
  });
});

describe('sanitizeOutput', () => {
  it('replaces token with [REDACTED]', () => {
    expect(sanitizeOutput('failed with ghp_secret', 'ghp_secret')).toBe('failed with [REDACTED]');
  });
  it('handles multiple occurrences', () => {
    expect(sanitizeOutput('abc and abc', 'abc')).toBe('[REDACTED] and [REDACTED]');
  });
  it('returns unchanged when token is empty', () => {
    expect(sanitizeOutput('error', '')).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Clone validation & command building
// ---------------------------------------------------------------------------

describe('validateCloneRequest', () => {
  const valid = { url: 'https://github.com/org/repo.git', token: 'ghp_test' };

  it('accepts valid request', () => expect(validateCloneRequest(valid)).toBeNull());
  it('accepts all optional fields', () => {
    expect(validateCloneRequest({ ...valid, path: '/workspace/r', branch: 'main', depth: 1, tokenUser: 'oauth2' })).toBeNull();
  });
  it('rejects missing url', () => expect(validateCloneRequest({ ...valid, url: '' })?.status).toBe(400));
  it('rejects non-HTTPS', () => expect(validateCloneRequest({ ...valid, url: 'git://x.com/r' })?.error).toContain('https://'));
  it('rejects embedded creds', () => expect(validateCloneRequest({ ...valid, url: 'https://u:p@x.com/r' })?.error).toContain('embedded'));
  it('rejects missing token', () => expect(validateCloneRequest({ ...valid, token: '' })?.status).toBe(400));
  it('rejects path outside /workspace', () => expect(validateCloneRequest({ ...valid, path: '/tmp/r' })?.status).toBe(403));
  it('rejects zero depth', () => expect(validateCloneRequest({ ...valid, depth: 0 })?.error).toContain('positive'));
});

describe('buildCloneCommand', () => {
  it('builds command with credential helper', () => {
    const { cmd, destPath } = buildCloneCommand({ url: 'https://github.com/org/repo.git', token: 'tok' });
    expect(cmd).toContain('git');
    expect(cmd).toContain('credential.helper=');
    expect(cmd).toContain('clone');
    expect(cmd).toContain('https://github.com/org/repo.git');
    expect(cmd).not.toContain('@github.com'); // no embedded cred
    expect(destPath).toBe('/workspace/repo');
  });
  it('includes --branch', () => {
    const { cmd } = buildCloneCommand({ url: 'https://x.com/r.git', token: 't', branch: 'dev' });
    expect(cmd).toContain('--branch dev');
  });
  it('includes --depth', () => {
    const { cmd } = buildCloneCommand({ url: 'https://x.com/r.git', token: 't', depth: 1 });
    expect(cmd).toContain('--depth 1');
  });
  it('uses custom path', () => {
    const { destPath } = buildCloneCommand({ url: 'https://x.com/r.git', token: 't', path: '/workspace/custom' });
    expect(destPath).toBe('/workspace/custom');
  });
});

// ---------------------------------------------------------------------------
// Pull validation & command building
// ---------------------------------------------------------------------------

describe('validatePullRequest', () => {
  const valid = { path: '/workspace/repo', token: 'tok' };

  it('accepts valid request', () => expect(validatePullRequest(valid)).toBeNull());
  it('accepts all options', () => {
    expect(validatePullRequest({ ...valid, remote: 'upstream', branch: 'main', force: true, rebase: true })).toBeNull();
  });
  it('rejects missing path', () => expect(validatePullRequest({ ...valid, path: '' })?.status).toBe(400));
  it('rejects path outside /workspace', () => expect(validatePullRequest({ ...valid, path: '/tmp' })?.status).toBe(403));
  it('rejects missing token', () => expect(validatePullRequest({ ...valid, token: '' })?.status).toBe(400));
  it('rejects non-boolean force', () => {
    expect(validatePullRequest({ ...valid, force: 'yes' as unknown as boolean })?.error).toContain('boolean');
  });
  it('rejects non-boolean rebase', () => {
    expect(validatePullRequest({ ...valid, rebase: 1 as unknown as boolean })?.error).toContain('boolean');
  });
});

describe('buildPullCommand', () => {
  it('builds basic pull', () => {
    const { cmd, repoPath } = buildPullCommand({ path: '/workspace/repo', token: 't' });
    expect(cmd).toContain('git');
    expect(cmd).toContain('pull');
    expect(cmd).toContain('origin');
    expect(cmd).toContain('credential.helper=');
    expect(repoPath).toBe('/workspace/repo');
  });
  it('includes --force', () => {
    const { cmd } = buildPullCommand({ path: '/workspace/r', token: 't', force: true });
    expect(cmd).toContain('--force');
  });
  it('includes --rebase', () => {
    const { cmd } = buildPullCommand({ path: '/workspace/r', token: 't', rebase: true });
    expect(cmd).toContain('--rebase');
  });
  it('uses custom remote and branch', () => {
    const { cmd } = buildPullCommand({ path: '/workspace/r', token: 't', remote: 'upstream', branch: 'dev' });
    expect(cmd).toContain('upstream');
    expect(cmd).toContain('dev');
  });
});

// ---------------------------------------------------------------------------
// Push validation & command building
// ---------------------------------------------------------------------------

describe('validatePushRequest', () => {
  const valid = { path: '/workspace/repo', token: 'tok' };

  it('accepts valid request', () => expect(validatePushRequest(valid)).toBeNull());
  it('rejects missing path', () => expect(validatePushRequest({ ...valid, path: '' })?.status).toBe(400));
  it('rejects missing token', () => expect(validatePushRequest({ ...valid, token: '' })?.status).toBe(400));
  it('rejects non-boolean force', () => {
    expect(validatePushRequest({ ...valid, force: 'yes' as unknown as boolean })?.error).toContain('boolean');
  });
});

describe('buildPushCommand', () => {
  it('builds basic push', () => {
    const { cmd, repoPath } = buildPushCommand({ path: '/workspace/repo', token: 't' });
    expect(cmd).toContain('git');
    expect(cmd).toContain('push');
    expect(cmd).toContain('origin');
    expect(repoPath).toBe('/workspace/repo');
  });
  it('includes --force', () => {
    const { cmd } = buildPushCommand({ path: '/workspace/r', token: 't', force: true });
    expect(cmd).toContain('--force');
  });
  it('uses custom remote and branch', () => {
    const { cmd } = buildPushCommand({ path: '/workspace/r', token: 't', remote: 'upstream', branch: 'main' });
    expect(cmd).toContain('upstream');
    expect(cmd).toContain('main');
  });
});

// ---------------------------------------------------------------------------
// Fetch validation & command building
// ---------------------------------------------------------------------------

describe('validateFetchRequest', () => {
  const valid = { path: '/workspace/repo', token: 'tok' };

  it('accepts valid request', () => expect(validateFetchRequest(valid)).toBeNull());
  it('accepts all options', () => {
    expect(validateFetchRequest({ ...valid, remote: 'upstream', branch: 'main', prune: true, depth: 5 })).toBeNull();
  });
  it('rejects missing path', () => expect(validateFetchRequest({ ...valid, path: '' })?.status).toBe(400));
  it('rejects non-boolean prune', () => {
    expect(validateFetchRequest({ ...valid, prune: 'yes' as unknown as boolean })?.error).toContain('boolean');
  });
  it('rejects invalid depth', () => expect(validateFetchRequest({ ...valid, depth: 0 })?.error).toContain('positive'));
});

describe('buildFetchCommand', () => {
  it('builds basic fetch', () => {
    const { cmd, repoPath } = buildFetchCommand({ path: '/workspace/repo', token: 't' });
    expect(cmd).toContain('git');
    expect(cmd).toContain('fetch');
    expect(cmd).toContain('origin');
    expect(repoPath).toBe('/workspace/repo');
  });
  it('includes --prune', () => {
    const { cmd } = buildFetchCommand({ path: '/workspace/r', token: 't', prune: true });
    expect(cmd).toContain('--prune');
  });
  it('includes --depth', () => {
    const { cmd } = buildFetchCommand({ path: '/workspace/r', token: 't', depth: 3 });
    expect(cmd).toContain('--depth 3');
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests (mock sandbox)
// ---------------------------------------------------------------------------

const mockExec = vi.fn();
const mockGetSandbox = vi.fn(() => ({ exec: mockExec }));

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('handleGitClone', () => {
  it('returns 200 with path on success', async () => {
    const res = await handleGitClone('test', { url: 'https://github.com/org/repo.git', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/workspace/repo');
  });

  it('returns 502 on clone failure', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'fatal: not found', exitCode: 128 });
    const res = await handleGitClone('test', { url: 'https://github.com/org/repo.git', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(502);
  });

  it('sanitizes token from errors', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'failed with MYTOKEN', exitCode: 128 });
    const res = await handleGitClone('test', { url: 'https://github.com/org/repo.git', token: 'MYTOKEN' }, mockGetSandbox);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain('MYTOKEN');
    expect(body.error).toContain('[REDACTED]');
  });

  it('returns 400 for invalid input', async () => {
    const res = await handleGitClone('test', { url: '', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('handleGitPull', () => {
  it('returns 200 on success', async () => {
    mockExec.mockResolvedValue({ stdout: 'Already up to date.', stderr: '', exitCode: 0 });
    const res = await handleGitPull('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; stdout: string };
    expect(body.ok).toBe(true);
    expect(body.stdout).toBe('Already up to date.');
  });

  it('runs in repo directory', async () => {
    await handleGitPull('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    const [, opts] = mockExec.mock.calls[0];
    expect(opts.cwd).toBe('/workspace/repo');
  });

  it('returns 502 on failure', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'merge conflict', exitCode: 1 });
    const res = await handleGitPull('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('pull_error');
  });

  it('returns 400 for missing path', async () => {
    const res = await handleGitPull('test', { path: '', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('sanitizes token from errors', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'auth SECRETTOKEN', exitCode: 128 });
    const res = await handleGitPull('test', { path: '/workspace/r', token: 'SECRETTOKEN' }, mockGetSandbox);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain('SECRETTOKEN');
  });
});

describe('handleGitPush', () => {
  it('returns 200 on success', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'To https://github.com/org/repo.git\n', exitCode: 0 });
    const res = await handleGitPush('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 502 on rejection', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'rejected', exitCode: 1 });
    const res = await handleGitPush('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('push_error');
  });

  it('returns 403 for path outside workspace', async () => {
    const res = await handleGitPush('test', { path: '/tmp/evil', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(403);
  });
});

describe('handleGitFetch', () => {
  it('returns 200 on success', async () => {
    const res = await handleGitFetch('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 502 on failure', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'failed', exitCode: 128 });
    const res = await handleGitFetch('test', { path: '/workspace/repo', token: 'tok' }, mockGetSandbox);
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('fetch_error');
  });

  it('returns 400 for missing token', async () => {
    const res = await handleGitFetch('test', { path: '/workspace/repo', token: '' }, mockGetSandbox);
    expect(res.status).toBe(400);
  });

  it('sanitizes token from success output too', async () => {
    mockExec.mockResolvedValue({ stdout: 'ref SECRETTOKEN', stderr: '', exitCode: 0 });
    const res = await handleGitFetch('test', { path: '/workspace/repo', token: 'SECRETTOKEN' }, mockGetSandbox);
    const body = await res.json() as { stdout: string };
    expect(body.stdout).not.toContain('SECRETTOKEN');
    expect(body.stdout).toContain('[REDACTED]');
  });
});
