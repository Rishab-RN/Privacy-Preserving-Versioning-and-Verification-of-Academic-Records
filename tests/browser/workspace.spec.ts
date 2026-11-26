import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const accounts = JSON.parse(readFileSync(resolve('.runtime/demo-accounts.json'), 'utf8')) as {
  subject: string;
  password: string;
  role: string;
}[];
const staff = JSON.parse(readFileSync(resolve('.runtime/workflow-accounts.json'), 'utf8')) as {
  subject: string;
  password: string;
}[];
const fixture = JSON.parse(readFileSync(resolve('.runtime/workflow-fixture.json'), 'utf8')) as {
  recordId: string;
  studentId: string;
  institutionId: string;
};
const out = resolve('.runtime/frontend-evidence');
async function login(
  page: Page,
  account: { subject: string; password: string },
  heading = 'Registrar desk',
) {
  await page.getByLabel('Account ID', { exact: true }).fill(account.subject);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}
test('live student, auditor and independent registrar browser journeys', async ({ page }) => {
  mkdirSync(out, { recursive: true });
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '01-sign-in.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Sign in to workspace' })).toBeInViewport();
  await page.screenshot({ path: resolve(out, '15-mobile-sign-in.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const example = page.getByRole('group', { name: 'Example stage' });
  await example.getByRole('button', { name: 'Proof', exact: true }).click();
  await expect(page.getByText('Private eligibility claim', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByLabel('Account ID', { exact: true }).fill('demo:student');
  await page.getByLabel('Password', { exact: true }).fill('incorrect-synthetic-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('UNAUTHORIZED');

  const student = accounts.find((a) => a.role === 'student')!;
  await login(page, student, 'Your academic record');
  await expect(
    page.getByLabel('Student', { exact: true }).locator('option:not([disabled])'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('navigation').getByRole('button', { name: 'Evidence' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '02-student-overview.png'), fullPage: true });
  await page.keyboard.press('Control+k');
  const finder = page.getByRole('dialog', { name: 'Find a page' });
  const search = finder.getByRole('searchbox', { name: 'Search workspace pages' });
  await expect(search).toBeFocused();
  await search.fill('Review');
  await expect(finder.getByRole('status')).toHaveText('No matching pages.');
  await search.fill('Records');
  await search.press('Enter');
  await expect(finder).toBeHidden();
  await expect(page.getByRole('columnheader', { name: 'Recorded at' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search course code' }).fill('NO_SUCH_COURSE');
  await expect(page.getByText('No course codes match your search.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search course code' }).fill('');
  await page.getByLabel('Known at (local time)', { exact: true }).fill('1990-01-01T00:00');
  await page.getByRole('button', { name: 'Apply time filters' }).click();
  await expect(page.getByRole('heading', { name: 'No results in this view' })).toBeVisible();
  await page.getByRole('button', { name: 'Current view' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.route('**/api/v1/students/*/transcript*', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Current view' }).click();
  await expect(page.getByRole('alert')).toContainText('CONNECTION_UNAVAILABLE');
  await page.unroute('**/api/v1/students/*/transcript*');
  await page.getByRole('button', { name: 'Current view' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '03-mobile-records.png'), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.getByRole('navigation').getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Propose a record correction' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(
    page,
    accounts.find((a) => a.role === 'auditor')!,
    'Audit workspace',
  );
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Evidence' })).toHaveCount(
    0,
  );
  await page.screenshot({ path: resolve(out, '13-auditor-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, staff[0]!);
  await page.screenshot({ path: resolve(out, '14-registrar-overview.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Evidence' }).click();
  await page.getByLabel('Record ID', { exact: true }).fill(fixture.recordId);
  await page
    .getByLabel('Supporting note', { exact: true })
    .fill('Synthetic browser journey evidence. No personal information.');
  await page.getByRole('button', { name: 'Save evidence', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Available' })).toBeVisible();
  await page.getByRole('button', { name: 'Retrieve evidence', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verified evidence content' })).toBeVisible();
  await page.getByLabel('Grade points', { exact: true }).fill('8.00');
  await page.getByLabel('Effective from (local time)', { exact: true }).fill('2000-01-01T00:00');
  await page
    .getByLabel('Reason for correction', { exact: true })
    .fill('Synthetic UI correction for independent review');
  const proposalKeys: string[] = [];
  await page.route('**/api/v1/records/*/change-requests', async (route) => {
    proposalKeys.push(route.request().headers()['idempotency-key']!);
    const response = await route.fetch();
    if (proposalKeys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Submit for independent review' }).click();
  await expect(page.getByRole('alert')).toContainText('CONNECTION_UNAVAILABLE');
  await page.getByRole('button', { name: 'Submit for independent review' }).click();
  const result = page.getByRole('status').filter({ hasText: 'Proposal submitted' });
  await expect(result).toBeVisible();
  expect(proposalKeys).toHaveLength(2);
  expect(proposalKeys[0]).toBe(proposalKeys[1]);
  await page.unroute('**/api/v1/records/*/change-requests');
  const requestId = (await result.innerText()).match(
    /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/,
  )![0];
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '04-evidence-proposal.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Find request', exact: true }).click();
  await expect(page.getByText('A different registrar must review your proposal.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve correction', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, staff[1]!);
  await page.getByRole('navigation').getByRole('button', { name: 'Review' }).click();
  await page.getByLabel('Request ID', { exact: true }).fill(requestId);
  await page.getByRole('button', { name: 'Find request', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Proposed correction', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Decision reason', { exact: true })
    .fill('Synthetic independent UI approval');
  await page.getByRole('button', { name: 'Approve correction', exact: true }).click();
  await expect(page.getByText('Confirm approval?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Confirm approval?', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve correction', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recorded decision' })).toBeVisible();
  await expect(page.getByText('Academic revision accepted', { exact: true })).toBeVisible();
  const applied = (
    await page.locator('small').filter({ hasText: 'Applied version' }).innerText()
  ).match(/Applied version (\d+)/)![1]!;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '05-independent-approval.png'), fullPage: true });
  if (process.env.GRAPH_NEO4J_PASSWORD) {
    await page.getByRole('button', { name: 'View version provenance' }).click();
    await expect(page.getByLabel('Grade record ID', { exact: true })).toHaveValue(fixture.recordId);
    await expect(page.getByLabel('Grade version', { exact: true })).toHaveValue(applied);
    await page.getByRole('button', { name: 'Load provenance' }).click();
    await expect(page.getByText('Graph catching up', { exact: true })).toBeVisible();
    if (process.env.ANOMALY_PYTHON) {
      await expect(page.getByText('Stale snapshot', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review this correction' })).toHaveCount(0);
    }
    await promisify(execFile)(
      process.execPath,
      [
        '--env-file-if-exists=.env',
        '--env-file-if-exists=.env.worker',
        '--env-file-if-exists=.env.graph',
        '--import',
        'tsx',
        'apps/api/scripts/graph/run.ts',
        'sync',
        fixture.institutionId,
      ],
      { timeout: 25000 },
    );
    await page.getByRole('button', { name: 'Load provenance' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Caught up', { exact: true })).toBeVisible();
    if (process.env.ANOMALY_PYTHON) {
      await promisify(execFile)(
        process.env.ANOMALY_PYTHON,
        ['apps/anomaly/run.py', 'publish', fixture.institutionId],
        { timeout: 30000 },
      );
      await page.getByRole('button', { name: 'Load provenance' }).click();
      await expect(page.getByText('Current snapshot', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Features that increased this score' }),
      ).toBeVisible();
      await expect(page.locator('.risk-detail')).toContainText(`Version ${applied} ·`);
      await page.locator('.risk-grid').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(out, '16-anomaly-review.png') });
    }
    const ancestry = page.getByRole('region', { name: 'Version ancestry' });
    await expect(ancestry.getByText(requestId, { exact: true })).toBeVisible();
    const relationships = page.getByRole('group', { name: 'Inspect approval relationships' });
    await relationships.getByRole('button', { name: 'Evidence', exact: true }).click();
    await expect(page.locator('.approval-detail')).toContainText(`Evidence · v${applied}`);
    const evidenceReuse = page
      .getByRole('group', { name: 'Choose a review signal' })
      .getByRole('button', { name: 'Evidence reuse', exact: true });
    await evidenceReuse.click();
    await expect(evidenceReuse).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: resolve(out, '12-neo4j-provenance.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.getByRole('navigation').getByRole('button', { name: 'Records' }).click();
  await page.getByLabel('Student', { exact: true }).selectOption(fixture.studentId);
  await page.getByRole('button', { name: 'Current view', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: fixture.recordId })).toContainText(
    `v${applied}`,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '06-revised-record.png'), fullPage: true });
  expect(
    await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0),
  ).toBeTruthy();
  await page.route('**/api/v1/students/*/transcript*', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
    }),
  );
  await page.getByRole('button', { name: 'Current view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.unroute('**/api/v1/students/*/transcript*');
  await login(page, student, 'Your academic record');
  await page.getByRole('navigation').getByRole('button', { name: 'Records' }).click();
  const showHistory = page.getByRole('button', { name: 'View DEMO_WORKFLOW history' });
  await showHistory.focus();
  await page.keyboard.press('Enter');
  const revisions = page.getByRole('region', { name: 'Recorded revisions' });
  const versionRow = (version: number) =>
    revisions.getByRole('row').filter({
      has: page.getByRole('cell', { name: `v${version}`, exact: true }),
    });
  await expect(versionRow(Number(applied))).toContainText('8.00');
  await expect(versionRow(Number(applied) - 1)).toBeVisible();
  const priorVersion = Number(applied) - 1;
  const inspect = page
    .getByRole('group', { name: 'Select recorded version' })
    .getByRole('button', { name: new RegExp(`^v${priorVersion}\\b`) });
  await inspect.click();
  await expect(inspect).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.version-detail')).toContainText(`Version ${priorVersion} ·`);
  await page.screenshot({ path: resolve(out, '11-student-recorded-history.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await showHistory.scrollIntoViewIfNeeded();
  await expect(showHistory).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
