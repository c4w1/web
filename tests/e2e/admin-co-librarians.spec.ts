import { expect, test } from '@playwright/test';
import { openPortal, seedDb, users } from './support/portal';

const DASHBOARD = '/web/librarian/';
const EDIT_KNOX = '/web/librarian/edit/?slug=knox-county';

test.describe('admins manage co-librarians', () => {
  test('approve a request from the dashboard, with a note', async ({ page, baseURL }) => {
    const db = seedDb();
    const { sent } = await openPortal(page, baseURL!, users.admin, db);
    await page.goto(DASHBOARD);

    const requests = page.locator('#admin-requests');
    await expect(requests).toBeVisible();
    const row = requests.locator(`li[data-request-email="${users.stranger.email}"]`);
    await expect(row).toContainText('For Knox County Data Library');
    await expect(row).toContainText('I teach stats at the high school');

    await row
      .getByRole('textbox', { name: `Note to ${users.stranger.email}` })
      .fill('Welcome aboard');
    await row.getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('#portal-status')).toContainText(
      `Approved ${users.stranger.email} for Knox County Data Library.`
    );
    await expect(row).toHaveCount(0);
    expect(db.rows.get('knox-county')!.editors).toContain(users.stranger.email);
    expect(sent.at(-1)?.to).toEqual([users.stranger.email]);
    expect(sent.at(-1)?.text).toContain('Welcome aboard');
  });

  test('deny a request from the dashboard', async ({ page, baseURL }) => {
    const db = seedDb();
    await openPortal(page, baseURL!, users.admin, db);
    await page.goto(DASHBOARD);

    const row = page.locator(`#admin-request-list li[data-request-email="${users.other.email}"]`);
    await row.getByRole('button', { name: 'Deny' }).click();

    await expect(page.locator('#portal-status')).toContainText(`Denied ${users.other.email}`);
    await expect(row).toHaveCount(0);
    expect(db.rows.get('knox-county')!.editors).not.toContain(users.other.email);
    expect(db.requests.map((r: { email: string }) => r.email)).toEqual([users.stranger.email]);
  });

  test('grant and remove co-librarian rights directly on a library they do not edit', async ({
    page,
    baseURL,
  }) => {
    const db = seedDb();
    await openPortal(page, baseURL!, users.admin, db);
    await page.goto(DASHBOARD);
    await page
      .locator('#admin-library-list li', { hasText: 'Knox County Data Library' })
      .getByRole('link', { name: 'Manage' })
      .click();
    // Locally the edit page takes ?slug=; on Netlify it is /web/librarian/<slug>/edit/.
    if (!page.url().includes('slug=')) await page.goto(EDIT_KNOX);

    const editors = page.locator('#editor-list');
    await expect(editors).toContainText(users.editor.email);
    await expect(page.locator('#f-name')).toBeDisabled();

    await page
      .getByRole('textbox', { name: 'Email of an editor to add' })
      .fill('teacher@school.edu');
    await page.getByRole('button', { name: 'Add editor' }).click();
    await expect(editors).toContainText('teacher@school.edu');
    expect(db.rows.get('knox-county')!.editors).toContain('teacher@school.edu');

    await editors
      .locator('li', { hasText: users.helper.email })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(editors).not.toContainText(users.helper.email);
    expect(db.rows.get('knox-county')!.editors).not.toContain(users.helper.email);
  });

  test('people who are not admins do not get the admin tools', async ({ page, baseURL }) => {
    const db = seedDb();
    await openPortal(page, baseURL!, users.stranger, db);
    await page.goto(DASHBOARD);
    await expect(page.locator('#mine')).toBeVisible();
    await expect(page.locator('#admin-requests')).toBeHidden();
    await expect(page.locator('#admin-libraries')).toBeHidden();

    await page.goto(EDIT_KNOX);
    await expect(page.locator('#portal-status')).toContainText(
      'Only this library’s editors can see its settings.'
    );
    await expect(page.locator('#editors')).toBeHidden();
  });
});
