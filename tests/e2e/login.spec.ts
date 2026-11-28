import { expect, test, type Page } from '@playwright/test';
import { loginCookie, PASSWORD, seedDb, startBackend, users } from './support/portal';

const DASHBOARD = '/web/librarian/';
const LOGIN = '/web/librarian/login/';
const EDIT_KNOX = '/web/librarian/edit/?slug=knox-county';

async function logIn(page: Page, email: string, password: string) {
  const form = page.locator('#login-form');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Log in' }).click();
}

test.describe('logging in and out', () => {
  test('the dashboard sends a signed-out visitor to the login page and back', async ({ page }) => {
    await startBackend(page, seedDb());
    await page.goto(DASHBOARD);
    await expect(page).toHaveURL(`${LOGIN}?next=${encodeURIComponent(DASHBOARD)}`);

    await logIn(page, users.editor.email, PASSWORD);
    await expect(page).toHaveURL(DASHBOARD);
    await expect(page.locator('#nav-email')).toHaveText(users.editor.email);
    await expect(page.locator('#mine')).toContainText('Knox County Data Library');
  });

  test('an edit page sends a signed-out visitor to log in, then back to that library', async ({
    page,
  }) => {
    await startBackend(page, seedDb());
    await page.goto(EDIT_KNOX);
    await expect(page).toHaveURL(`${LOGIN}?next=${encodeURIComponent(EDIT_KNOX)}`);

    await logIn(page, users.editor.email, PASSWORD);
    await expect(page).toHaveURL(EDIT_KNOX);
    await expect(page.locator('#f-name')).toHaveValue('Knox County Data Library');
    await expect(page.locator('#f-name')).toBeEnabled();
  });

  test('an admin who logs in gets the admin tools', async ({ page }) => {
    await startBackend(page, seedDb());
    await page.goto(DASHBOARD);
    await logIn(page, users.admin.email, PASSWORD);
    await expect(page).toHaveURL(DASHBOARD);
    await expect(page.locator('#admin-requests')).toBeVisible();
    await expect(page.locator('#admin-libraries')).toContainText('Anderson Library');
  });

  test('a wrong password shows an error and stays on the login page', async ({ page, baseURL }) => {
    await startBackend(page, seedDb());
    await page.goto(DASHBOARD);
    await expect(page).toHaveURL(/\/web\/librarian\/login\//);

    await logIn(page, users.editor.email, 'not-the-password');
    await expect(page.locator('#login-form .form-error')).toContainText('password invalid');
    await expect(page).toHaveURL(/\/web\/librarian\/login\//);
    await expect(page.locator('#login-form').getByRole('button', { name: 'Log in' })).toBeEnabled();
    expect(await loginCookie(page, baseURL!)).toBeNull();
  });

  test('an unknown email shows the same error', async ({ page }) => {
    await startBackend(page, seedDb());
    await page.goto(LOGIN);
    await logIn(page, 'nobody@example.org', PASSWORD);
    await expect(page.locator('#login-form .form-error')).toContainText('password invalid');
    await expect(page).toHaveURL(LOGIN);
  });

  test('a login link pointing off the site still lands on the dashboard', async ({ page }) => {
    await startBackend(page, seedDb());
    await page.goto(`${LOGIN}?next=${encodeURIComponent('https://example.com/phish')}`);
    await logIn(page, users.editor.email, PASSWORD);
    await expect(page).toHaveURL(DASHBOARD);
  });

  test('someone already logged in skips the login page', async ({ page }) => {
    await startBackend(page, seedDb());
    await page.goto(LOGIN);
    await logIn(page, users.editor.email, PASSWORD);
    await expect(page).toHaveURL(DASHBOARD);

    await page.goto(`${LOGIN}?next=${encodeURIComponent(EDIT_KNOX)}`);
    await expect(page).toHaveURL(EDIT_KNOX);
  });

  test('log out ends the session and protected pages ask to log in again', async ({
    page,
    baseURL,
  }) => {
    await startBackend(page, seedDb());
    await page.goto(LOGIN);
    await logIn(page, users.editor.email, PASSWORD);
    await expect(page).toHaveURL(DASHBOARD);
    expect(await loginCookie(page, baseURL!)).not.toBeNull();

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(LOGIN);
    expect(await loginCookie(page, baseURL!)).toBeNull();

    await page.goto(EDIT_KNOX);
    await expect(page).toHaveURL(`${LOGIN}?next=${encodeURIComponent(EDIT_KNOX)}`);
  });
});
