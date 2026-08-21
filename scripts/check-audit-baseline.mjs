import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const baselinePath = new URL(
  '../config/security-audit-baseline.json',
  import.meta.url
);

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
  return current;
}

export async function main() {
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

  if (audit.error) {
    throw new Error(`Could not execute npm audit: ${audit.error.message}`);
  }

  if (!audit.stdout) {
    throw new Error(audit.stderr || 'npm audit produced no JSON output');
  }

  const report = parseAuditReport(audit.stdout);
  const current = collectAdvisories(report);
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

    throw new Error(
      `Review dependency debt and update #${baseline.trackingIssue} before changing the baseline.`
    );
  }

  const resolvedCount = baseline.advisories.filter(
    (advisory) => !current.some((candidate) => key(candidate) === key(advisory))
  ).length;

  console.log(
    `npm audit baseline accepted: ${current.length} known advisories tracked by #${baseline.trackingIssue}; ` +
      `${resolvedCount} baseline advisories resolved; baseline expires ${baseline.expires}.`
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
