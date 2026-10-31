import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const trustedAuditVersion = '3';
const trackingIssue = 141;

// Untrusted inputs (the PR tree) are read with hard size caps so a PR cannot
// exhaust the runner, and their contents are never echoed into job logs.
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org/';
// Lock flags that decide whether a package ships in the production install
// (`npm ci --omit=dev`). They are part of each accepted advisory's binding.
const LOCK_SCOPE_FLAGS = ['dev', 'devOptional', 'optional', 'peer'];
const LOCK_NODE_PATH_PATTERN =
  /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/;
const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const PACKAGE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const MAX_APPROVAL_COMMENT_PAGES = 20;
const MAX_APPROVAL_CANDIDATES = 25;
const MAX_REPORTED_LOCK_PROBLEMS = 20;

const SEVERITY_ORDER = new Map([
  ['low', 0],
  ['moderate', 1],
  ['high', 2],
  ['critical', 3],
]);
const TRUSTED_APPROVAL_PERMISSIONS = new Set(['admin', 'write']);
// Anchored to the whole (trimmed) comment body and case-sensitive: a comment
// that only quotes the line, or adds any other text, is not an approval.
const EXTERNAL_APPROVAL_PATTERN =
  /^SECURITY-AUDIT-APPROVAL v1 policySha256=([0-9a-f]{64}) trackingIssue=([1-9]\d*)$/;

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isUneditedComment(comment) {
  const created = comment?.created_at;
  if (
    typeof created !== 'string' ||
    created !== comment?.updated_at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)
  ) {
    return false;
  }
  const date = new Date(created);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString() === created.replace(/Z$/, '.000Z')
  );
}

function advisoryKey(advisory) {
  return `${advisory.source}:${advisory.package}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeAuditNodes(nodes) {
  if (!Array.isArray(nodes)) {
    return [];
  }

  return [...new Set(nodes.filter((node) => typeof node === 'string'))].sort();
}

function normalizeNodeScopes(nodes, nodeScopes) {
  if (
    !nodeScopes ||
    typeof nodeScopes !== 'object' ||
    Array.isArray(nodeScopes)
  ) {
    return null;
  }

  return Object.fromEntries(
    normalizeAuditNodes(nodes).map((node) => {
      const scope = Object.prototype.hasOwnProperty.call(nodeScopes, node)
        ? nodeScopes[node]
        : null;
      return [node, typeof scope === 'string' ? scope : null];
    })
  );
}

function sameAuditNodes(left, right) {
  const leftNodes = normalizeAuditNodes(left);
  const rightNodes = normalizeAuditNodes(right);
  return (
    leftNodes.length === rightNodes.length &&
    leftNodes.every((node, index) => node === rightNodes[index])
  );
}

function sameAuditBinding(accepted, current) {
  if (!sameAuditNodes(accepted.nodes, current.nodes)) {
    return false;
  }
  const acceptedScopes = normalizeNodeScopes(
    accepted.nodes,
    accepted.nodeScopes
  );
  const currentScopes = normalizeNodeScopes(current.nodes, current.nodeScopes);
  return JSON.stringify(acceptedScopes) === JSON.stringify(currentScopes);
}

export function lockEntryScope(entry) {
  const flags = LOCK_SCOPE_FLAGS.filter((flag) => entry?.[flag] === true);
  return flags.length > 0 ? flags.join('+') : 'prod';
}

// Binds each advisory install path to its lock scope (prod, dev, optional...),
// so moving an accepted dev-only package into the production install is a
// binding change that needs a new review.
export function annotateAdvisoryScopes(advisories, lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error(
      'package-lock.json has no packages map to bind audit paths'
    );
  }

  return advisories.map((advisory) => {
    const nodes = normalizeAuditNodes(advisory.nodes);
    if (nodes.length === 0) {
      return advisory;
    }
    const nodeScopes = {};
    for (const node of nodes) {
      const entry = Object.prototype.hasOwnProperty.call(packages, node)
        ? packages[node]
        : undefined;
      if (!entry || typeof entry !== 'object') {
        throw new Error(
          `npm audit reported dependency path ${JSON.stringify(node)} that package-lock.json does not contain`
        );
      }
      nodeScopes[node] = lockEntryScope(entry);
    }
    return { ...advisory, nodes, nodeScopes };
  });
}

function canonicalAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) {
    throw new Error('Invalid security audit advisory in accepted baseline');
  }

  const canonical = {
    source: String(advisory.source),
    package: String(advisory.package),
    severity: String(advisory.severity),
    url: advisory.url == null ? null : String(advisory.url),
  };
  const nodes = normalizeAuditNodes(advisory.nodes);
  if (nodes.length > 0) {
    canonical.nodes = nodes;
    const nodeScopes = normalizeNodeScopes(nodes, advisory.nodeScopes);
    if (nodeScopes) {
      canonical.nodeScopes = nodeScopes;
    }
  }
  return canonical;
}

export function computeAdvisorySetDigest(advisories) {
  if (!Array.isArray(advisories)) {
    throw new Error('Security audit advisory set must be an array');
  }

  const canonical = advisories.map(canonicalAdvisory).sort((left, right) => {
    return (
      compareText(left.source, right.source) ||
      compareText(left.package, right.package) ||
      compareText(left.severity, right.severity) ||
      compareText(left.url ?? '', right.url ?? '') ||
      compareText(
        JSON.stringify(left.nodes ?? []),
        JSON.stringify(right.nodes ?? [])
      ) ||
      compareText(
        JSON.stringify(left.nodeScopes ?? null),
        JSON.stringify(right.nodeScopes ?? null)
      )
    );
  });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function computeReviewedPolicyDigest(advisories, policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Invalid security audit policy metadata');
  }

  const canonical = {
    advisoriesSha256: computeAdvisorySetDigest(advisories),
    expires: String(policy.expires),
    minimumSeverity: String(policy.minimumSeverity),
    trackingIssue: String(policy.trackingIssue),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function filterBlockingAdvisories(advisories, minimumSeverity) {
  const minimumRank = SEVERITY_ORDER.get(minimumSeverity);
  if (minimumRank === undefined) {
    throw new Error(
      `Unsupported npm audit severity threshold: ${minimumSeverity}`
    );
  }

  return advisories.filter((advisory) => {
    const rank = SEVERITY_ORDER.get(advisory.severity);
    if (rank === undefined) {
      throw new Error(
        `Unsupported npm audit advisory severity: ${advisory.severity}`
      );
    }
    return rank >= minimumRank;
  });
}

export function validateBaselinePolicy(policy, today) {
  if (
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    !Number.isInteger(policy.trackingIssue) ||
    policy.trackingIssue <= 0 ||
    !SEVERITY_ORDER.has(policy.minimumSeverity)
  ) {
    throw new Error('Invalid security audit policy metadata');
  }

  if (!isCalendarDate(today)) {
    throw new Error(`Invalid security audit current date: ${today}`);
  }
  if (!isCalendarDate(policy.expires)) {
    throw new Error(`Invalid security audit expiry date: ${policy.expires}`);
  }

  const review = policy.review;
  if (
    !review ||
    review.status !== 'accepted' ||
    typeof review.reviewedBy !== 'string' ||
    review.reviewedBy.trim() === '' ||
    typeof review.rationale !== 'string' ||
    review.rationale.trim() === '' ||
    typeof review.advisoriesSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(review.advisoriesSha256) ||
    typeof review.policySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(review.policySha256)
  ) {
    throw new Error(
      'Security audit exceptions require an accepted review bound to advisory and policy digests'
    );
  }
  if (!isCalendarDate(review.reviewedOn)) {
    throw new Error(`Invalid security audit review date: ${review.reviewedOn}`);
  }

  if (today > policy.expires) {
    throw new Error(
      `Security audit policy expired on ${policy.expires}; review tracked debt in #${policy.trackingIssue}`
    );
  }
}

export function validateReviewedPolicyBinding(baseline, policy) {
  if (!baseline || !Array.isArray(baseline.advisories)) {
    throw new Error('Invalid security audit baseline metadata');
  }

  const computedDigest = computeReviewedPolicyDigest(
    baseline.advisories,
    policy
  );
  const reviewedDigest = policy.review?.policySha256?.toLowerCase();
  if (computedDigest !== reviewedDigest) {
    throw new Error(
      `Security audit reviewed-policy digest does not match the accepted advisory set, expiry, severity threshold, and tracking issue (computed ${computedDigest}, reviewed ${reviewedDigest}); renew review under #${policy.trackingIssue}.`
    );
  }
}

export function parseExternalAuditApproval(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const match = body.trim().match(EXTERNAL_APPROVAL_PATTERN);
  if (!match) {
    return null;
  }

  return {
    policySha256: match[1],
    trackingIssue: Number(match[2]),
  };
}

export function expectedApprovalLine(policy) {
  return `SECURITY-AUDIT-APPROVAL v1 policySha256=${policy.review.policySha256.toLowerCase()} trackingIssue=${policy.trackingIssue}`;
}

export function validateExternalAuditApproval(policy, approvals) {
  const expectedDigest = policy?.review?.policySha256?.toLowerCase();
  if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error(
      'Security audit external approval requires a valid reviewed policy digest'
    );
  }
  if (!Array.isArray(approvals)) {
    throw new Error(
      'Security audit external approval records must be an array'
    );
  }

  for (const approval of approvals) {
    const parsed = parseExternalAuditApproval(approval?.body);
    if (
      !parsed ||
      parsed.policySha256 !== expectedDigest ||
      parsed.trackingIssue !== policy.trackingIssue
    ) {
      continue;
    }
    if (!TRUSTED_APPROVAL_PERMISSIONS.has(approval.permission)) {
      continue;
    }
    if (typeof approval.author !== 'string' || approval.author.trim() === '') {
      continue;
    }

    return {
      author: approval.author,
      permission: approval.permission,
      policySha256: parsed.policySha256,
      trackingIssue: parsed.trackingIssue,
    };
  }

  throw new Error(
    `Security audit policy ${expectedDigest} requires an exact external approval under #${policy.trackingIssue} from a repository writer or administrator.`
  );
}

async function fetchGitHubJson(
  url,
  token,
  fetchImpl,
  { description, allowNotFound = false }
) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `timed out after ${GITHUB_FETCH_TIMEOUT_MS} ms`
        : 'request failed';
    throw new Error(`GitHub security audit ${description} ${reason}`);
  }
  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub security audit ${description} failed with HTTP ${response.status}`
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(
      `GitHub security audit ${description} returned invalid JSON`
    );
  }
}

export async function verifyExternalAuditApproval(
  policy,
  {
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  if (policy?.trackingIssue !== trackingIssue) {
    throw new Error(
      `Security audit approval must be recorded under #${trackingIssue}`
    );
  }
  if (
    typeof repository !== 'string' ||
    !/^[^/]+\/[^/]+$/.test(repository) ||
    typeof token !== 'string' ||
    token === '' ||
    typeof fetchImpl !== 'function'
  ) {
    throw new Error(
      'Security audit external approval verification requires a GitHub repository, token, and fetch implementation'
    );
  }
  const expectedDigest = policy.review?.policySha256?.toLowerCase();
  if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error(
      'Security audit external approval requires a valid reviewed policy digest'
    );
  }

  // Only comments whose whole body is exactly the expected line cost a
  // permission lookup, and the lookups are capped, so pasted copies on the
  // public tracking issue cannot drain the token or stall the gate.
  const expectedLine = expectedApprovalLine(policy);
  const [owner, repo] = repository.split('/');
  let candidates = 0;
  for (let page = 1; page <= MAX_APPROVAL_COMMENT_PAGES; page += 1) {
    const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${trackingIssue}/comments?per_page=100&page=${page}`;
    const comments = await fetchGitHubJson(commentsUrl, token, fetchImpl, {
      description: `approval comment lookup (page ${page})`,
    });
    if (!Array.isArray(comments)) {
      throw new Error(
        'GitHub security audit approval comments response is invalid'
      );
    }

    for (const comment of comments) {
      if (
        typeof comment?.body !== 'string' ||
        comment.body.trim() !== expectedLine ||
        !isUneditedComment(comment)
      ) {
        continue;
      }

      const author = comment?.user?.login;
      if (typeof author !== 'string' || author === '') {
        continue;
      }
      candidates += 1;
      if (candidates > MAX_APPROVAL_CANDIDATES) {
        throw new Error(
          `Security audit approval lookup found more than ${MAX_APPROVAL_CANDIDATES} matching comments on #${trackingIssue} without a trusted author; remove the copies or restrict #${trackingIssue} to collaborators.`
        );
      }
      const permissionUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(author)}/permission`;
      const permission = await fetchGitHubJson(
        permissionUrl,
        token,
        fetchImpl,
        {
          description: `permission lookup for approval comment ${Number(comment.id) || 'unknown'} by ${JSON.stringify(author)}`,
          allowNotFound: true,
        }
      );
      if (TRUSTED_APPROVAL_PERMISSIONS.has(permission?.permission)) {
        return validateExternalAuditApproval(policy, [
          { body: comment.body, author, permission: permission.permission },
        ]);
      }
    }

    if (comments.length < 100) {
      return validateExternalAuditApproval(policy, []);
    }
  }

  throw new Error(
    `Security audit external approval lookup exceeded ${MAX_APPROVAL_COMMENT_PAGES} pages for #${trackingIssue}`
  );
}

export function validateAuditProcessResult(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error('npm audit returned an invalid process result');
  }

  if (audit.signal != null) {
    throw new Error(`npm audit was terminated by signal ${audit.signal}`);
  }

  if (audit.status !== 0 && audit.status !== 1) {
    throw new Error(
      `npm audit exited unexpectedly with status ${audit.status}`
    );
  }
}

export function parseAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Could not parse npm audit output: ${error.message}`);
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('npm audit returned an invalid JSON report shape');
  }

  if (report.error) {
    const message =
      typeof report.error === 'object' && report.error !== null
        ? report.error.summary ||
          report.error.message ||
          JSON.stringify(report.error)
        : String(report.error);
    throw new Error(`npm audit failed: ${message}`);
  }

  if (
    !Object.prototype.hasOwnProperty.call(report, 'vulnerabilities') ||
    typeof report.vulnerabilities !== 'object' ||
    report.vulnerabilities === null ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error('npm audit report is missing a vulnerabilities object');
  }

  return report;
}

export function collectAdvisories(report) {
  const current = [];
  for (const [packageName, vulnerability] of Object.entries(
    report.vulnerabilities
  )) {
    const nodes = normalizeAuditNodes(vulnerability.nodes);
    for (const via of vulnerability.via || []) {
      if (via && typeof via === 'object') {
        current.push({
          source: String(via.source),
          package: packageName,
          severity: via.severity,
          url: via.url,
          ...(nodes.length > 0 ? { nodes } : {}),
        });
      }
    }
  }
  return current;
}

export function formatAdvisoryDiagnostic(advisory, previousSeverity) {
  const severity = previousSeverity
    ? `${previousSeverity} -> ${advisory.severity}`
    : advisory.severity;
  const location = advisory.url || advisory.source;
  const nodes = normalizeAuditNodes(advisory.nodes);
  const paths =
    nodes.length > 0
      ? nodes.join(', ')
      : '(dependency path not reported by npm audit)';

  return `- ${advisory.package} ${severity} ${location}; paths: ${paths}`;
}

function formatScopedNodes(nodes, nodeScopes, emptyText) {
  if (nodes.length === 0) {
    return emptyText;
  }
  return nodes
    .map((node) => `${node} (${nodeScopes?.[node] ?? 'scope not recorded'})`)
    .join(', ');
}

export function formatPathChangeDiagnostic(change) {
  const previous = formatScopedNodes(
    change.previousNodes,
    change.previousNodeScopes,
    '(none recorded)'
  );
  const current = formatScopedNodes(
    change.nodes,
    change.nodeScopes,
    '(none reported)'
  );
  return `- ${change.package} ${change.severity} ${change.url || change.source}; previous paths: ${previous}; current paths: ${current}`;
}

function lockEntryName(lockPath, entry) {
  if (typeof entry.name === 'string') {
    return entry.name;
  }
  const marker = 'node_modules/';
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
}

export function canonicalRegistryTarball(name, version) {
  const basename = name.startsWith('@')
    ? name.slice(name.indexOf('/') + 1)
    : name;
  return `${NPM_REGISTRY_ORIGIN}${name}/-/${basename}-${version}.tgz`;
}

// `npm audit --package-lock-only` trusts each lock entry's `version`, while
// `npm ci` installs whatever `resolved` + `integrity` point at. Every package
// entry must therefore resolve to the public registry tarball of its own
// name@version, so the audited version is the installed version.
export function validateLockfileSources(lock) {
  if (
    !lock ||
    typeof lock !== 'object' ||
    Array.isArray(lock) ||
    (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) ||
    !lock.packages ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  ) {
    throw new Error(
      'package-lock.json must be lockfileVersion 2 or 3 with a packages map'
    );
  }

  const problems = [];
  for (const [lockPath, entry] of Object.entries(lock.packages)) {
    if (lockPath === '') {
      continue;
    }
    const where = JSON.stringify(lockPath);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where}: invalid lock entry`);
      continue;
    }
    if (!LOCK_NODE_PATH_PATTERN.test(lockPath)) {
      problems.push(`${where}: only node_modules package entries are allowed`);
      continue;
    }
    if (entry.link === true) {
      problems.push(`${where}: linked local packages are not allowed`);
      continue;
    }
    if (entry.inBundle === true) {
      problems.push(`${where}: bundled dependencies are not allowed`);
      continue;
    }
    const name = lockEntryName(lockPath, entry);
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      problems.push(`${where}: invalid package name`);
      continue;
    }
    if (
      typeof entry.version !== 'string' ||
      !PACKAGE_VERSION_PATTERN.test(entry.version)
    ) {
      problems.push(`${where}: missing or invalid version`);
      continue;
    }
    if (entry.resolved !== canonicalRegistryTarball(name, entry.version)) {
      problems.push(
        `${where}: resolved is not the registry tarball for ${name}@${entry.version}`
      );
      continue;
    }
    if (
      typeof entry.integrity !== 'string' ||
      !SHA512_INTEGRITY_PATTERN.test(entry.integrity)
    ) {
      problems.push(`${where}: missing or invalid sha512 integrity`);
    }
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED_LOCK_PROBLEMS);
    const more =
      problems.length > shown.length
        ? `\n- ... and ${problems.length - shown.length} more`
        : '';
    throw new Error(
      `package-lock.json has ${problems.length} entries that do not resolve to canonical npm registry tarballs:\n- ${shown.join('\n- ')}${more}`
    );
  }
}

export function compareAuditAdvisories(baseline, policy, report, lock) {
  if (
    !baseline.trackingIssue ||
    !Array.isArray(baseline.advisories) ||
    baseline.trackingIssue !== policy.trackingIssue
  ) {
    throw new Error(
      'Invalid security audit baseline metadata or policy tracking mismatch'
    );
  }

  const baselineDigest = computeAdvisorySetDigest(baseline.advisories);
  const reviewedDigest = policy.review?.advisoriesSha256?.toLowerCase();
  if (baselineDigest !== reviewedDigest) {
    throw new Error(
      `Security audit review digest does not match the exact accepted advisory set (computed ${baselineDigest}, reviewed ${reviewedDigest}); re-review dependency debt under #${policy.trackingIssue}.`
    );
  }

  const collected = collectAdvisories(report);
  const current = filterBlockingAdvisories(
    lock === undefined ? collected : annotateAdvisoryScopes(collected, lock),
    policy.minimumSeverity
  );
  const blockingBaseline = filterBlockingAdvisories(
    baseline.advisories,
    policy.minimumSeverity
  );
  const baselineByKey = new Map(
    blockingBaseline.map((advisory) => [advisoryKey(advisory), advisory])
  );
  const currentKeys = new Set(current.map(advisoryKey));
  const resolvedAdvisories = blockingBaseline.filter(
    (advisory) => !currentKeys.has(advisoryKey(advisory))
  );

  if (resolvedAdvisories.length > 0) {
    throw new Error(
      `Security audit baseline contains ${resolvedAdvisories.length} resolved advisories; prune resolved exceptions before CI can pass.`
    );
  }

  const newAdvisories = current.filter(
    (advisory) => !baselineByKey.has(advisoryKey(advisory))
  );
  const severityChanges = current.filter((advisory) => {
    const existing = baselineByKey.get(advisoryKey(advisory));
    return existing && existing.severity !== advisory.severity;
  });
  const pathChanges = current.flatMap((advisory) => {
    const existing = baselineByKey.get(advisoryKey(advisory));
    if (!existing || sameAuditBinding(existing, advisory)) {
      return [];
    }
    return [
      {
        ...advisory,
        nodes: normalizeAuditNodes(advisory.nodes),
        previousNodes: normalizeAuditNodes(existing.nodes),
        previousNodeScopes: existing.nodeScopes,
      },
    ];
  });

  return {
    current,
    blockingBaseline,
    baselineByKey,
    newAdvisories,
    severityChanges,
    pathChanges,
    resolvedCount: 0,
  };
}

// Reads one file from the untrusted data directory without following symlinks
// (in any path component), without blocking on FIFOs or devices, and without
// reading more than maxBytes.
export async function readUntrustedFile(dataDir, relativePath, maxBytes) {
  const segments = relativePath.split('/');
  let directory = dataDir;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    let stats;
    try {
      stats = await lstat(directory);
    } catch {
      throw new Error(`Audit input directory for ${relativePath} is missing`);
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Audit input directory for ${relativePath} must be a real directory, not a symlink`
      );
    }
  }

  let handle;
  try {
    handle = await open(
      join(dataDir, relativePath),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    throw new Error(
      `Audit input ${relativePath} must be a readable regular file, not a symlink (${error?.code ?? 'open failed'})`
    );
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Audit input ${relativePath} must be a regular file`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `Audit input ${relativePath} exceeds the ${maxBytes}-byte limit`
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new Error(
        `Audit input ${relativePath} exceeds the ${maxBytes}-byte limit`
      );
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// Parse errors from untrusted files are reported without the parser message,
// because V8 echoes the start of the input into the public job log.
export function parseUntrustedJson(bytes, relativePath) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Audit input ${relativePath} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Audit input ${relativePath} must contain a JSON object`);
  }
  return value;
}

async function readUntrustedJson(dataDir, relativePath, maxBytes) {
  const bytes = await readUntrustedFile(dataDir, relativePath, maxBytes);
  return { bytes, value: parseUntrustedJson(bytes, relativePath) };
}

export async function main({ dataDir = scriptRoot } = {}) {
  const { value: baseline } = await readUntrustedJson(
    dataDir,
    'config/security-audit-baseline.json',
    MAX_CONFIG_BYTES
  );
  const { value: policy } = await readUntrustedJson(
    dataDir,
    'config/security-audit-policy.json',
    MAX_CONFIG_BYTES
  );
  const today = new Date().toISOString().slice(0, 10);

  validateBaselinePolicy(policy, today);
  validateReviewedPolicyBinding(baseline, policy);
  await verifyExternalAuditApproval(policy);

  const manifest = await readUntrustedJson(
    dataDir,
    'package.json',
    MAX_MANIFEST_BYTES
  );
  const lockfile = await readUntrustedJson(
    dataDir,
    'package-lock.json',
    MAX_MANIFEST_BYTES
  );
  const lock = lockfile.value;
  validateLockfileSources(lock);

  const auditDir = await mkdtemp(join(tmpdir(), 'terrastories-audit-input-'));
  let audit;
  try {
    await writeFile(join(auditDir, 'package.json'), manifest.bytes, {
      mode: 0o600,
    });
    await writeFile(join(auditDir, 'package-lock.json'), lockfile.bytes, {
      mode: 0o600,
    });
    audit = spawnSync(
      'npm',
      [
        'audit',
        '--json',
        '--package-lock-only',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org/',
        '--audit-level',
        policy.minimumSeverity,
      ],
      {
        cwd: auditDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          NPM_CONFIG_USERCONFIG: join(auditDir, 'empty-user-config'),
          NPM_CONFIG_GLOBALCONFIG: join(auditDir, 'empty-global-config'),
          NPM_CONFIG_CACHE: join(auditDir, 'cache'),
        },
      }
    );
  } finally {
    await rm(auditDir, { recursive: true, force: true });
  }

  if (audit.error) {
    throw new Error(`Could not execute npm audit: ${audit.error.message}`);
  }

  validateAuditProcessResult(audit);

  if (!audit.stdout) {
    throw new Error(audit.stderr || 'npm audit produced no JSON output');
  }

  const report = parseAuditReport(audit.stdout);
  const {
    current,
    baselineByKey,
    newAdvisories,
    severityChanges,
    pathChanges,
  } = compareAuditAdvisories(baseline, policy, report, lock);

  if (
    newAdvisories.length > 0 ||
    severityChanges.length > 0 ||
    pathChanges.length > 0
  ) {
    if (newAdvisories.length > 0) {
      process.stderr.write('New blocking npm audit advisories detected:\n');
      for (const advisory of newAdvisories) {
        process.stderr.write(`${formatAdvisoryDiagnostic(advisory)}\n`);
      }
    }

    if (severityChanges.length > 0) {
      process.stderr.write('Existing npm audit advisories changed severity:\n');
      for (const advisory of severityChanges) {
        const previous = baselineByKey.get(advisoryKey(advisory));
        process.stderr.write(
          `${formatAdvisoryDiagnostic(advisory, previous.severity)}\n`
        );
      }
    }

    if (pathChanges.length > 0) {
      process.stderr.write(
        'Existing npm audit advisories changed dependency installation paths:\n'
      );
      for (const change of pathChanges) {
        process.stderr.write(`${formatPathChangeDiagnostic(change)}\n`);
      }
    }

    throw new Error(
      `Review dependency debt and update #${policy.trackingIssue} before changing the accepted exception set.`
    );
  }

  console.log(
    `npm audit baseline accepted at ${policy.minimumSeverity}+: ${current.length} exact known advisories tracked by #${policy.trackingIssue}; policy expires ${policy.expires}.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--trusted-audit-version') {
    console.log(trustedAuditVersion);
  } else if (
    args.length !== 0 &&
    !(args.length === 2 && args[0] === '--data-dir' && args[1])
  ) {
    process.stderr.write(
      'Usage: trusted-audit-baseline.mjs [--data-dir DIR]\n'
    );
    process.exitCode = 1;
  } else {
    main(args.length === 0 ? {} : { dataDir: args[1] }).catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`
      );
      process.exit(1);
    });
  }
}
