import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RVCE_2022_ITL_S1 } from '@academic-records/assessment';
import { generatePilotData } from '@academic-records/pilot-data';

// The marks-to-results pilot, driven through the web desks by each persona in turn. It needs a
// freshly provisioned pilot (`npm run pilot:setup`); the synthetic passwords stay in the
// ignored accounts file and are only typed into the sign-in form.
const accountsPath = resolve(process.env.PILOT_ACCOUNTS ?? '.runtime/pilot-accounts.json');
const out = resolve('.runtime/frontend-evidence');
const data = generatePilotData();
const AI_A = 'CD252IA · AI-A';

function password(subject: string) {
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')) as {
    subject: string;
    password: string;
  }[];
  const found = accounts.find((account) => account.subject === subject);
  if (!found) throw new Error(`No pilot account ${subject}`);
  return found.password;
}

async function signIn(page: Page, subject: string) {
  await page.goto('/');
  await page.getByLabel('Account ID', { exact: true }).fill(subject);
  await page.getByLabel('Password', { exact: true }).fill(password(subject));
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15000 });
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
}

async function openDesk(page: Page, tab: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Marks & results' })
    .click();
  await expect(page.getByRole('heading', { name: 'Marks and results', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: tab }).click();
}

/** Types a stage's marks for AI-A from the synthetic dataset into the entry grid. */
async function enterMarks(page: Page, stage: 'cie' | 'see') {
  const codes = new Set(
    RVCE_2022_ITL_S1.groups
      .filter((group) => group.part === stage)
      .flatMap((group) => group.components.filter((c) => !c.optional).map((c) => c.code)),
  );
  for (const assessment of data.assessments.filter((a) => a.offering === 'ai-a')) {
    for (const [code, value] of Object.entries(assessment.marks)) {
      if (codes.has(code)) {
        await page.getByLabel(`${assessment.usn} ${code}`, { exact: true }).fill(value);
      }
    }
  }
}

// A dedicated API process: the journey signs in nine times, and sign-ins are limited per process.
test.use({ baseURL: process.env.PILOT_BASE_URL ?? 'http://127.0.0.1:5178' });

test('pilot marks travel from entry to a corrected, published result', async ({ page }) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(accountsPath), 'Run npm run pilot:setup first');
  mkdirSync(out, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The API allows 100 requests a minute per address, and the journey runs inside one minute.
  let apiCalls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls += 1;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await test.step('F1 enters and submits AI-A CIE marks', async () => {
    await signIn(page, 'pilot:f1');
    await expect(page.getByRole('heading', { name: 'Marks and results', level: 1 })).toBeVisible();
    await page.getByRole('tab', { name: 'Marks entry' }).click();
    await expect(page.getByRole('region', { name: 'Marks entry grid' })).toBeVisible();
    test.skip(
      !(await page.getByText('No revision yet').isVisible()),
      'AI-A already has marks; the journey needs a freshly provisioned pilot',
    );
    await enterMarks(page, 'cie');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.getByText('Saved revision 1.')).toBeVisible();
    await page.screenshot({ path: resolve(out, 'pilot-01-cie-entry.png'), fullPage: true });
    await page.getByRole('button', { name: 'Submit revision 1' }).click();
    await expect(page.getByText('Submitted for department review.')).toBeVisible();
    await signOut(page);
  });

  await test.step('S1 validates the submitted revision under the delegation', async () => {
    await signIn(page, 'pilot:s1');
    await openDesk(page, 'Exam office');
    const item = page.getByRole('listitem').filter({ hasText: AI_A }).filter({ hasText: 'CIE' });
    await item.getByRole('textbox').fill('Roster reconciled against the SLcM export');
    await item.getByRole('button', { name: 'Record validation' }).click();
    await expect(page.getByText('0 enrolled students have no row')).toBeVisible();
    await signOut(page);
  });

  await test.step('H1 approves the AI-A CIE revision', async () => {
    await signIn(page, 'pilot:h1');
    await openDesk(page, 'Department review');
    await page
      .getByRole('listitem')
      .filter({ hasText: AI_A })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('button', { name: 'Approve revision' }).click();
    await expect(page.getByText('Approved revision 1.')).toBeVisible();
    await signOut(page);
  });

  await test.step('E1 enters and submits AI-A SEE marks', async () => {
    await signIn(page, 'pilot:e1');
    await page.getByRole('tab', { name: 'Marks entry' }).click();
    await expect(page.getByText('No revision yet')).toBeVisible();
    await enterMarks(page, 'see');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.getByText('Saved revision 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Submit revision 1' }).click();
    await expect(page.getByText('Submitted to the exam section for publication.')).toBeVisible();
    await signOut(page);
  });

  await test.step('P1 publishes provisional results with imported attendance', async () => {
    await signIn(page, 'pilot:p1');
    await page.getByRole('tab', { name: 'Publication' }).click();
    await expect(page.getByText('CIE approved')).toBeVisible();
    await expect(page.getByText('SEE submitted')).toBeVisible();
    const csv = data.assessments
      .filter((a) => a.offering === 'ai-a')
      .map((a) => `${a.usn},${a.attendance.percent ?? ''},${a.attendance.eligible ? 'yes' : 'no'}`)
      .join('\n');
    await page.getByLabel('Paste attendance').fill(csv);
    await page.getByRole('button', { name: 'Apply pasted attendance' }).click();
    await expect(page.getByLabel('SYN24AI007 eligible')).not.toBeChecked();
    await page.getByRole('button', { name: 'Publish provisional results' }).click();
    await expect(page.getByText('Published 12 provisional results.')).toBeVisible();
    await expect(page.getByText('Audit: all 12 grades recompute')).toBeVisible();
    await page.screenshot({ path: resolve(out, 'pilot-02-publication.png'), fullPage: true });
    await signOut(page);
  });

  let requestId = '';
  await test.step('R1 records a paper-viewing revaluation for SYN24AI003', async () => {
    await signIn(page, 'pilot:r1');
    await openDesk(page, 'Paper viewing');
    await page.getByRole('button', { name: 'Revalue SYN24AI003' }).click();
    await page.getByLabel(/^see_part_b \(now 20\.00/).fill('26');
    await page.getByLabel('Reason').fill('Expert team revaluation after paper viewing');
    await page.getByRole('button', { name: 'File correction request' }).click();
    const filed = page.getByRole('status').filter({ hasText: 'Correction request filed.' });
    await expect(filed).toBeVisible();
    requestId = /request ([0-9a-f-]{36})/.exec((await filed.textContent()) ?? '')?.[1] ?? '';
    expect(requestId).not.toBe('');
    await signOut(page);
  });

  await test.step('R2 approves the correction on the Review page', async () => {
    await signIn(page, 'pilot:r2');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Review', exact: true })
      .click();
    await page.getByLabel('Request ID').fill(requestId);
    await page.getByRole('button', { name: 'Find request' }).click();
    await page.getByLabel('Decision reason').fill('Revaluation checked against the scheme');
    await page.getByRole('button', { name: 'Approve correction' }).click();
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByRole('button', { name: 'Approve correction' })).toBeHidden();
    await signOut(page);
  });

  await test.step('P1 publishes final results once paper viewing is settled', async () => {
    await signIn(page, 'pilot:p1');
    await page.getByRole('tab', { name: 'Publication' }).click();
    await page.getByRole('button', { name: 'Publish final results' }).click();
    await expect(
      page.getByText('Declared 12 results final; 1 changed after paper viewing.'),
    ).toBeVisible();
    await expect(page.getByText(/^Final since/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish final results' })).toBeHidden();
    await page.screenshot({ path: resolve(out, 'pilot-03-final.png'), fullPage: true });
    await signOut(page);
  });

  await test.step('the student sees the corrected, final result', async () => {
    await signIn(page, 'pilot:syn24ai003');
    await openDesk(page, 'My results');
    const card = page.getByRole('article').filter({ hasText: 'CD252IA' });
    await expect(card.getByText('Final', { exact: true })).toBeVisible();
    await expect(card.getByText('Revised after paper viewing')).toBeVisible();
    await expect(card.getByLabel('Grade B+')).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(1);
    await page.screenshot({ path: resolve(out, 'pilot-04-final-result.png'), fullPage: true });
    await signOut(page);
  });

  expect(errors).toEqual([]);
  console.info(`Pilot journey API requests: ${apiCalls}`);
  expect(apiCalls).toBeLessThan(90);
});
