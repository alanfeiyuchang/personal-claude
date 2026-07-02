// Git status/log for the rail's git panel — read-only queries against the
// active session's working directory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function git(dir, ...args) {
  const { stdout } = await execFileP('git', ['-C', dir, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return stdout.trim();
}

// git@github.com:user/repo.git / https://github.com/user/repo.git → browse URL
function httpsRemote(url) {
  if (!url) return null;
  const ssh = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(url)) return url.replace(/\.git$/, '');
  return null;
}

export async function getGitInfo(dir) {
  try {
    await git(dir, 'rev-parse', '--is-inside-work-tree');
  } catch {
    return { repo: false };
  }

  const [branch, status, counts, origin, log] = await Promise.all([
    git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '?'),
    git(dir, 'status', '--porcelain').catch(() => ''),
    git(dir, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD').catch(() => null),
    git(dir, 'remote', 'get-url', 'origin').catch(() => null),
    git(dir, 'log', '-20', '--pretty=format:%H%x1f%s%x1f%an%x1f%ct').catch(() => ''),
  ]);

  const remoteUrl = httpsRemote(origin);
  let ahead = 0;
  let behind = 0;
  if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);

  const commits = log
    ? log.split('\n').map((line) => {
        const [sha, subject, author, ct] = line.split('\x1f');
        return {
          sha,
          subject,
          author,
          ts: Number(ct) * 1000,
          url: remoteUrl ? `${remoteUrl}/commit/${sha}` : null,
        };
      })
    : [];

  return {
    repo: true,
    branch,
    changed: status ? status.split('\n').filter(Boolean).length : 0,
    ahead,
    behind,
    remoteUrl,
    commits,
  };
}
