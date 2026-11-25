import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
async function runLog(command: string, args: string[]) {
  await exec(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--env-file-if-exists=.env.log',
      '--import',
      'tsx',
      'apps/log/src/main.ts',
      command,
      ...args,
    ],
    { timeout: 20_000 },
  );
}

test('student proves locally, verifier rejects tampering/replay and current-status revocation', async ({
  page,
}) => {
  test.setTimeout(120000);
  const accounts = JSON.parse(readFileSync(resolve('.runtime/demo-accounts.json'), 'utf8')) as {
    subject: string;
    password: string;
    role: string;
  }[];
  const student = accounts.find((a) => a.role === 'student')!,
    registrar = accounts.find((a) => a.role === 'registrar')!;
  const fixture = JSON.parse(readFileSync(resolve('.runtime/workflow-fixture.json'), 'utf8')) as {
    recordId: string;
    institutionId: string;
  };
  const out = resolve('.runtime/frontend-evidence');
  mkdirSync(out, { recursive: true });
  await page.goto('/');
  await page.getByLabel('Account ID', { exact: true }).fill(student.subject);
  await page.getByLabel('Password', { exact: true }).fill(student.password);
  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  const { token: studentToken } = (await (await loginResponse).json()) as { token: string };
  for (const holder of ['not-a-number', '9'.repeat(77)]) {
    const invalid = await page.request.post(
      '/api/v1/zk/records/' + fixture.recordId + '/credentials',
      {
        headers: { Authorization: 'Bearer ' + studentToken },
        data: { credentialId: crypto.randomUUID(), holder },
      },
    );
    expect(invalid.status()).toBe(400);
  }
  await expect(page.getByRole('heading', { name: 'Records with a history.' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Private proofs' }).click();
  await page.getByLabel('Approved record', { exact: true }).selectOption(fixture.recordId);
  await page.getByRole('button', { name: 'Issue private proof credential', exact: true }).click();
  await expect(page.getByText('Proof credential issued', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const currentWallet = page
    .getByRole('status')
    .filter({ hasText: 'Proof credential issued' })
    .locator('code');
  const previousId = await currentWallet.innerText();
  const preview = page.locator('.disclosure-preview');
  await expect(preview).toContainText(previousId);
  await expect(preview).toContainText(fixture.recordId);
  const evidence = `.runtime/log-demo/browser-${randomUUID()}.json`;
  await runLog('publish', ['--log-id', fixture.institutionId]);
  await runLog('export', [
    '--log-id',
    fixture.institutionId,
    '--credential-id',
    previousId,
    '--out',
    evidence,
  ]);
  await page.getByRole('button', { name: 'Consent & generate ZK proof', exact: true }).click();
  await expect(page.getByText('Zero-knowledge proof generated', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.getByText('Inspect public proof JSON', { exact: true }).click();
  const first = await page.locator('.proof-json').innerText();
  const firstBundle = JSON.parse(first) as {
    proof: { pi_a: string[] };
    challengeId: string;
    statement: unknown;
  };
  expect(first).not.toContain('"secret"');
  expect(first).not.toContain('"salt"');
  expect(first).not.toContain('"grade"');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(out, '07-local-zero-knowledge-proof.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Consent & generate ZK proof', exact: true }).click();
  await expect(page.getByText('Zero-knowledge proof generated', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.getByText('Inspect public proof JSON', { exact: true }).click();
  const second = await page.locator('.proof-json').innerText();
  await page.getByRole('button', { name: 'Issue private proof credential', exact: true }).click();
  await expect(currentWallet).not.toHaveText(previousId);
  await page.goto('/verify');
  const wrong = structuredClone(firstBundle);
  wrong.proof.pi_a[0] = '1';
  await page.getByLabel('Shareable proof JSON', { exact: true }).fill(JSON.stringify(wrong));
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('invalid');
  const challenge = await page.request.get('/api/v1/zk/challenges/' + firstBundle.challengeId);
  expect(((await challenge.json()) as { used: boolean }).used).toBe(false);
  await page.getByLabel('Shareable proof JSON', { exact: true }).fill(first);
  const historyInput = page.getByLabel('Signed issuance evidence (optional)', { exact: true });
  const modified = JSON.parse(readFileSync(evidence, 'utf8')) as { inclusionProof: string[] };
  modified.inclusionProof[0] = '0'.repeat(64);
  await historyInput.setInputFiles({
    name: 'altered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(modified)),
  });
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('inclusion proof is invalid');
  await historyInput.setInputFiles(evidence);
  await page.getByRole('button', { name: 'Check signed history only', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Included in signed history/)).toBeVisible();
  const afterHistory = await page.request.get('/api/v1/zk/challenges/' + firstBundle.challengeId);
  expect(((await afterHistory.json()) as { used: boolean }).used).toBe(false);
  await page.route('**/api/v1/zk/verify', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByText('Current status unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText(/Included in signed history/)).toBeVisible();
  await page.unroute('**/api/v1/zk/verify');
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByText('Verified · threshold met', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText(/Current status checked at/)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, '08-private-proof-accepted.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: resolve(out, '09-private-proof-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already been consumed');
  const q = (await (
    await page.request.get('/api/v1/zk/challenges/' + firstBundle.challengeId)
  ).json()) as { credentialId: string };
  await page.goto('/');
  await page.getByLabel('Account ID', { exact: true }).fill(registrar.subject);
  await page.getByLabel('Password', { exact: true }).fill(registrar.password);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Credential status', exact: true })
    .click();
  await page.getByLabel('Credential ID', { exact: true }).fill(q.credentialId);
  await page
    .getByLabel('Revocation reason', { exact: true })
    .fill('Synthetic browser revocation check');
  await page.getByRole('button', { name: 'Revoke credential permanently', exact: true }).click();
  await expect(page.getByText('Credential revoked', { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(out, '10-credential-revoked.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto('/verify');
  await page.getByLabel('Shareable proof JSON', { exact: true }).fill(second);
  await historyInput.setInputFiles(evidence);
  await page.getByRole('button', { name: 'Verify proof', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('revoked');
  await expect(page.getByText(/Included in signed history/)).toBeVisible();
});
