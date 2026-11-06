import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('../public/fixtures/en-open.wav', import.meta.url));

test('a WAV heard through the pipeline, its transcripts read', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('wav').setInputFiles(fixture);
  await expect(page.getByTestId('result')).toContainText('open(book=moby, chapter=3) · deterministic');
  await expect(page.getByTestId('input-device')).toContainText('file (file)');
  await expect(page.locator('[data-testid^="utterance-"]').first()).toContainText('fixture');
});
