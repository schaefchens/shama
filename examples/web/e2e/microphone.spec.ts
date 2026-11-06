import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// A recording as Chromium's microphone: the demo's diagnostics with audio through the page's own
// capture, the worklet and the worker.
const microphone = fileURLToPath(new URL('../public/fixtures/en-live.wav', import.meta.url));

// Only Chromium takes a file as its microphone.
test.skip(({ browserName }) => browserName !== 'chromium');
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`] },
});

test('the microphone, the meter, an utterance kept, played and saved', async ({ page }) => {
  await page.goto('/');
  const talk = page.getByTestId('talk');
  await talk.hover();
  await page.mouse.down();
  await expect(page.getByTestId('input-device')).toContainText('kHz → 16 kHz');
  await expect(page.getByTestId('meter')).toContainText('dB');
  await page.waitForTimeout(3500);
  await page.mouse.up();
  const utterance = page.locator('[data-testid^="utterance-"]').first();
  await expect(utterance).toContainText('ended by release');
  await utterance.getByRole('button', { name: 'Play' }).click();
  const download = page.waitForEvent('download');
  await utterance.getByRole('button', { name: 'Save WAV' }).click();
  const saved = readFileSync(await (await download).path());
  expect(saved.subarray(0, 4).toString()).toBe('RIFF');
  expect(saved.length).toBeGreaterThan(16_000);
  await page.getByTestId('tab-Log').click();
  await expect(page.getByTestId('log')).toContainText('input: ');
  await expect(page.getByTestId('log')).toContainText('audio kept');
});
