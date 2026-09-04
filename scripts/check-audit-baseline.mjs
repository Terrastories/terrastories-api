import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const baselinePath = new URL(
  '../config/security-audit-baseline.json',
  import.meta.url
);
const policyPath = new URL(
  '../config/security-audit-policy.json',
  import.meta.url
);

const SEVERITY_ORDER = new Map([
  ['low', 0],
  ['moderate', 1],
  ['high', 2],
  ['critical', 3],
]);
const TRUSTED_APPROVAL_PERMISSIONS = new Set(['admin', 'write']);
const EXTERNAL_APPROVAL_PATTERN =
  /^SECURITY-AUDIT-APPROVAL v1 policySha256=([0-9a-f]{64}) trackingIssue=(\d+)$/im;

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

function sameAuditNodes(left, right) {
  const leftNodes = normalizeAuditNodes(left);
  const rightNodes = normalizeAuditNodes(right);
  return (
    leftNodes.length === rightNodes.length &&
    leftNodes.every((node, index) => node === rightNodes[index])
  );
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
    !policy.trackingIssue ||
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

  const match = body.match(EXTERNAL_APPROVAL_PATTERN);
  if (!match) {
    return null;
  }

  return {
    policySha256: match[1].toLowerCase(),
    trackingIssue: Number(match[2]),
  };
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
      parsed.trackingIssue !== Number(policy.trackingIssue)
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

async function fetchGitHubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub security audit approval lookup failed with HTTP ${response.status}`
    );
  }
  return response.json();
}

export async function verifyExternalAuditApproval(
  policy,
  {
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN,
    fetchImpl = globalThis.fetch,
  } = {}
) {
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

  const [owner, repo] = repository.split('/');
  const approvals = [];
  for (let page = 1; page <= 100; page += 1) {
    const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${policy.trackingIssue}/comments?per_page=100&page=${page}`;
    const comments = await fetchGitHubJson(commentsUrl, token, fetchImpl);
    if (!Array.isArray(comments)) {
      throw new Error(
        'GitHub security audit approval comments response is invalid'
      );
    }

    for (const comment of comments) {
      const parsed = parseExternalAuditApproval(comment?.body);
      if (
        !parsed ||
        parsed.policySha256 !== policy.review?.policySha256?.toLowerCase() ||
        parsed.trackingIssue !== Number(policy.trackingIssue)
      ) {
        continue;
      }

      const author = comment?.user?.login;
      if (typeof author !== 'string' || author === '') {
        continue;
      }
      const permissionUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(author)}/permission`;
      const permission = await fetchGitHubJson(permissionUrl, token, fetchImpl);
      approvals.push({
        body: comment.body,
        author,
        permission: permission?.permission,
      });
    }

    if (comments.length < 100) {
      return validateExternalAuditApproval(policy, approvals);
    }
  }

  throw new Error(
    `Security audit external approval lookup exceeded 100 pages for #${policy.trackingIssue}`
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

export function formatPathChangeDiagnostic(change) {
  const previous =
    change.previousNodes.length > 0
      ? change.previousNodes.join(', ')
      : '(none recorded)';
  const current =
    change.nodes.length > 0 ? change.nodes.join(', ') : '(none reported)';
  return `- ${change.package} ${change.severity} ${change.url || change.source}; previous paths: ${previous}; current paths: ${current}`;
}

export function compareAuditAdvisories(baseline, policy, report) {
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

  const current = filterBlockingAdvisories(
    collectAdvisories(report),
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
    if (!existing || sameAuditNodes(existing.nodes, advisory.nodes)) {
      return [];
    }
    return [
      {
        ...advisory,
        nodes: normalizeAuditNodes(advisory.nodes),
        previousNodes: normalizeAuditNodes(existing.nodes),
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

export async function main() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  validateBaselinePolicy(policy, today);
  validateReviewedPolicyBinding(baseline, policy);
  if (process.env.REQUIRE_EXTERNAL_AUDIT_APPROVAL === '1') {
    await verifyExternalAuditApproval(policy);
  }

  const audit = spawnSync(
    'npm',
    ['audit', '--json', '--audit-level', policy.minimumSeverity],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

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
  } = compareAuditAdvisories(baseline, policy, report);

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
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
