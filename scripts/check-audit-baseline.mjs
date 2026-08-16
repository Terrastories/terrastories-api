import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const baselinePath = new URL(
  '../config/security-audit-baseline.json',
  import.meta.url
);
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

if (
  !baseline.trackingIssue ||
  !baseline.expires ||
  !Array.isArray(baseline.advisories)
) {
  throw new Error('Invalid security audit baseline metadata');
}

if (today > baseline.expires) {
  throw new Error(
    `Security audit baseline expired on ${baseline.expires}; review tracked debt in #${baseline.trackingIssue}`
  );
}

const audit = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (!audit.stdout) {
  process.stderr.write(audit.stderr || 'npm audit produced no JSON output\n');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch (error) {
  process.stderr.write(`Could not parse npm audit output: ${error.message}\n`);
  process.exit(1);
}

const current = [];
for (const [packageName, vulnerability] of Object.entries(
  report.vulnerabilities || {}
)) {
  for (const via of vulnerability.via || []) {
    if (via && typeof via === 'object') {
      current.push({
        source: String(via.source),
        package: packageName,
        severity: via.severity,
        url: via.url,
      });
    }
  }
}

const key = (advisory) => `${advisory.source}:${advisory.package}`;
const baselineByKey = new Map(
  baseline.advisories.map((advisory) => [key(advisory), advisory])
);
const newAdvisories = current.filter(
  (advisory) => !baselineByKey.has(key(advisory))
);
const severityChanges = current.filter((advisory) => {
  const existing = baselineByKey.get(key(advisory));
  return existing && existing.severity !== advisory.severity;
});

if (newAdvisories.length > 0 || severityChanges.length > 0) {
  if (newAdvisories.length > 0) {
    process.stderr.write('New npm audit advisories detected:\n');
    for (const advisory of newAdvisories) {
      process.stderr.write(
        `- ${advisory.package} ${advisory.severity} ${advisory.url || advisory.source}\n`
      );
    }
  }

  if (severityChanges.length > 0) {
    process.stderr.write('Existing npm audit advisories changed severity:\n');
    for (const advisory of severityChanges) {
      const previous = baselineByKey.get(key(advisory));
      process.stderr.write(
        `- ${advisory.package} ${previous.severity} -> ${advisory.severity} ${advisory.url || advisory.source}\n`
      );
    }
  }

  process.stderr.write(
    `Review dependency debt and update #${baseline.trackingIssue} before changing the baseline.\n`
  );
  process.exit(1);
}

const resolvedCount = baseline.advisories.filter(
  (advisory) => !current.some((candidate) => key(candidate) === key(advisory))
).length;

console.log(
  `npm audit baseline accepted: ${current.length} known advisories tracked by #${baseline.trackingIssue}; ` +
    `${resolvedCount} baseline advisories resolved; baseline expires ${baseline.expires}.`
);
