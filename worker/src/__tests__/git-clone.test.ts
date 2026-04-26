import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCloneCommand,
  defaultClonePath,
  handleGitClone,
  resolveWorkspacePath,
  sanitizeOutput,
  shellQuote,
  validateRequest,
} from '../git-clone';
import type { GitCloneRequest } from '../git-clone';

// ---------------------------------------------------------------------------
// Unit tests — pure functions (no mocks needed)
// ---------------------------------------------------------------------------

describe('resolveWorkspacePath', () => {
  it('resolves absolute paths within /workspace', () => {
    expect(resolveWorkspacePath('/workspace/repo')).toBe('/workspace/repo');
  });

  it('resolves relative paths against /workspace', () => {
    expect(resolveWorkspacePath('repo')).toBe('/workspace/repo');
  });

  it('resolves nested relative paths', () => {
    expect(resolveWorkspacePath('org/repo')).toBe('/workspace/org/repo');
  });

  it('accepts /workspace itself', () => {
    expect(resolveWorkspacePath('/workspace')).toBe('/workspace');
  });

  it('rejects paths that escape /workspace via traversal', () => {
    expect(resolveWorkspacePath('/workspace/../../etc')).toBeNull();
  });

  it('rejects paths entirely outside /workspace', () => {
    expect(resolveWorkspacePath('/tmp/repo')).toBeNull();
  });

  it('normalizes dot segments', () => {
    expect(resolveWorkspacePath('/workspace/./src/../repo')).toBe('/workspace/repo');
  });
});

describe('defaultClonePath', () => {
  it('extracts repo name from GitHub URL', () => {
    expect(defaultClonePath('https://github.com/org/my-repo.git'))
      .toBe('/workspace/my-repo');
  });

  it('handles URL without .git suffix', () => {
    expect(defaultClonePath('https://github.com/org/my-repo'))
      .toBe('/workspace/my-repo');
  });

  it('handles GitLab-style nested paths', () => {
    expect(defaultClonePath('https://gitlab.com/group/subgroup/project.git'))
      .toBe('/workspace/project');
  });

  it('falls back to "repo" for empty basename', () => {
    expect(defaultClonePath('https://github.com/')).toBe('/workspace/repo');
  });
});

describe('shellQuote', () => {
  it('returns safe strings unquoted', () => {
    expect(shellQuote('hello')).toBe('hello');
    expect(shellQuote('/workspace/repo')).toBe('/workspace/repo');
    expect(shellQuote('key=value')).toBe('key=value');
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

  it('escapes newlines', () => {
    expect(shellQuote('a\nb')).toBe("$'a\\nb'");
  });
});

describe('sanitizeOutput', () => {
  it('replaces token occurrences with [REDACTED]', () => {
    expect(sanitizeOutput('failed to auth with ghp_secret123', 'ghp_secret123'))
      .toBe('failed to auth with [REDACTED]');
  });

  it('handles multiple occurrences', () => {
    expect(sanitizeOutput('token=abc and abc again', 'abc'))
      .toBe('token=[REDACTED] and [REDACTED] again');
  });

  it('returns output unchanged when token is empty', () => {
    expect(sanitizeOutput('some error', '')).toBe('some error');
  });

  it('returns output unchanged when token not present', () => {
    expect(sanitizeOutput('some error', 'nothere')).toBe('some error');
  });
});

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

describe('validateRequest', () => {
  const validBody: GitCloneRequest = {
    url: 'https://github.com/org/repo.git',
    token: 'ghp_test123'
  };

  it('returns null for valid request', () => {
    expect(validateRequest(validBody)).toBeNull();
  });

  it('returns null with all optional fields', () => {
    expect(validateRequest({
      ...validBody,
      path: '/workspace/my-repo',
      branch: 'develop',
      depth: 1,
      tokenUser: 'oauth2'
    })).toBeNull();
  });

  it('rejects missing url', () => {
    const err = validateRequest({ ...validBody, url: '' });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('url');
  });

  it('rejects non-HTTPS url', () => {
    const err = validateRequest({ ...validBody, url: 'git://github.com/org/repo.git' });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('https://');
  });

  it('rejects ssh:// url', () => {
    const err = validateRequest({ ...validBody, url: 'ssh://git@github.com/org/repo.git' });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('https://');
  });

  it('rejects url with embedded credentials', () => {
    const err = validateRequest({ ...validBody, url: 'https://user:pass@github.com/org/repo.git' });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('embedded credentials');
  });

  it('rejects missing token', () => {
    const err = validateRequest({ ...validBody, token: '' });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('token');
  });

  it('rejects path that escapes /workspace', () => {
    const err = validateRequest({ ...validBody, path: '/tmp/repo' });
    expect(err?.status).toBe(403);
    expect(err?.error).toContain('/workspace');
  });

  it('rejects path with traversal', () => {
    const err = validateRequest({ ...validBody, path: '/workspace/../../etc' });
    expect(err?.status).toBe(403);
    expect(err?.error).toContain('/workspace');
  });

  it('rejects non-integer depth', () => {
    const err = validateRequest({ ...validBody, depth: 0.5 });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('positive integer');
  });

  it('rejects zero depth', () => {
    const err = validateRequest({ ...validBody, depth: 0 });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('positive integer');
  });

  it('rejects negative depth', () => {
    const err = validateRequest({ ...validBody, depth: -1 });
    expect(err?.status).toBe(400);
    expect(err?.error).toContain('positive integer');
  });
});

// ---------------------------------------------------------------------------
// buildCloneCommand
// ---------------------------------------------------------------------------

describe('buildCloneCommand', () => {
  it('builds a basic clone command with credential helper', () => {
    const { cmd, destPath } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'ghp_abc123'
    });

    // Should contain git -c credential.helper=... clone <url> <path>
    expect(cmd).toContain('git');
    expect(cmd).toContain('-c');
    expect(cmd).toContain('credential.helper=');
    expect(cmd).toContain('clone');
    expect(cmd).toContain('https://github.com/org/repo.git');
    expect(destPath).toBe('/workspace/repo');

    // The token should appear in the credential helper, not in the URL
    expect(cmd).toContain('ghp_abc123');
    // URL should NOT have embedded credentials
    expect(cmd).not.toContain('@github.com');
  });

  it('includes --branch when specified', () => {
    const { cmd } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      branch: 'develop'
    });
    expect(cmd).toContain('--branch develop');
  });

  it('includes --depth when specified', () => {
    const { cmd } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      depth: 1
    });
    expect(cmd).toContain('--depth 1');
  });

  it('uses custom tokenUser', () => {
    const { cmd } = buildCloneCommand({
      url: 'https://gitlab.com/group/project.git',
      token: 'glpat_xyz',
      tokenUser: 'oauth2'
    });
    expect(cmd).toContain('oauth2');
  });

  it('uses custom path', () => {
    const { destPath } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      path: '/workspace/custom'
    });
    expect(destPath).toBe('/workspace/custom');
  });

  it('uses relative path resolved against /workspace', () => {
    const { destPath } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      path: 'my-project'
    });
    expect(destPath).toBe('/workspace/my-project');
  });

  it('credential helper uses x-access-token by default', () => {
    const { cmd } = buildCloneCommand({
      url: 'https://github.com/org/repo.git',
      token: 'tok'
    });
    expect(cmd).toContain('x-access-token');
  });
});

// ---------------------------------------------------------------------------
// handleGitClone — integration with mock sandbox
// ---------------------------------------------------------------------------

describe('handleGitClone', () => {
  const mockExec = vi.fn();
  const mockGetSandbox = vi.fn(() => ({ exec: mockExec }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('returns 200 with path on successful clone', async () => {
    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token: 'ghp_test'
    }, mockGetSandbox);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/workspace/repo');
  });

  it('calls sandbox.exec with the clone command', async () => {
    await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token: 'ghp_test'
    }, mockGetSandbox);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [cmd, opts] = mockExec.mock.calls[0];
    expect(cmd).toContain('git');
    expect(cmd).toContain('clone');
    expect(cmd).toContain('credential.helper=');
    expect(opts.cwd).toBe('/workspace');
    expect(opts.timeout).toBe(120_000);
  });

  it('returns 502 when clone fails', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'fatal: repository not found',
      exitCode: 128
    });

    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token: 'ghp_test'
    }, mockGetSandbox);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('clone_error');
    expect(body.error).toContain('exit code 128');
  });

  it('sanitizes token from error messages', async () => {
    const token = 'ghp_supersecret';
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: `fatal: could not read auth with ${token}`,
      exitCode: 128
    });

    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token
    }, mockGetSandbox);

    const body = await res.json() as { error: string };
    expect(body.error).not.toContain(token);
    expect(body.error).toContain('[REDACTED]');
  });

  it('sanitizes token from exception messages', async () => {
    const token = 'ghp_supersecret';
    mockExec.mockRejectedValue(new Error(`connection failed for ${token}`));

    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token
    }, mockGetSandbox);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain(token);
    expect(body.error).toContain('[REDACTED]');
  });

  it('returns 400 for invalid input', async () => {
    const res = await handleGitClone('test', {
      url: '',
      token: 'tok'
    }, mockGetSandbox);

    expect(res.status).toBe(400);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('returns 403 for path outside /workspace', async () => {
    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      path: '/tmp/evil'
    }, mockGetSandbox);

    expect(res.status).toBe(403);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('uses custom path in the result', async () => {
    const res = await handleGitClone('test', {
      url: 'https://github.com/org/repo.git',
      token: 'tok',
      path: '/workspace/my-custom-dir'
    }, mockGetSandbox);

    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path).toBe('/workspace/my-custom-dir');
  });
});
