import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fixtureJobs, mountJobs } from './jobs-fixture.mjs';
import { failureCopy } from '../src/shared/job-detail.mjs';
import zh from '../src/shared/copy/jobs-zh-CN.mjs';
import en from '../src/shared/copy/jobs-en.mjs';

test('lost-job details show localized diagnostics and omit resume sentence for non-render jobs', async t => {
  const image = await sharp({create:{width:16,height:16,channels:3,background:'#888'}}).png().toBuffer();
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const [language, copy] of [['zh-CN', zh], ['en', en]]) {
    const page = await browser.newPage(), jobs = fixtureJobs();
    const job = jobs.find(j => j.jobId === 'failed'); job.lost = true;
    const { errors } = await mountJobs(page, { jobs, language, theme: 'dark', reduced: true, media: async () => ({body:image,contentType:'image/png'}) });
    await page.locator('[data-job=failed] .name').click();
    await page.locator('[data-tab=summary]').click();
    for (const command of ['render', 'verify', 'stills']) for (const stderr of ['', Array.from({length:20},(_,i)=>`line ${i+5} <error>`).join('\n')]) {
      job.command = command; job.stderr = stderr;
      await page.evaluate(jobs => window.publish({jobs}), jobs);
      const hint = copy[failureCopy(job)[1]];
      assert.ok((await page.locator('#banner').innerText()).includes(hint));
      const labels = await page.locator('.err-card dt').allTextContents();
      assert.equal(labels.includes(copy.errOutput), Boolean(stderr));
      if (stderr) {
        assert.equal(await page.locator('.err-card .orig').last().innerText(), stderr);
        assert.equal(await page.locator('.err-card error').count(), 0);
      }
      if (command !== 'render') assert.ok(!hint.includes(language === 'en' ? 'Finished segments' : '已完成的片段'));
    }
    assert.deepEqual(errors, []); await page.close();
  }
});
