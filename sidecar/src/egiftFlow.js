'use strict';
module.exports = { runEgiftImport };

async function runEgiftImport({ driver, parse, site, email, link, save, delayMs = 3000 } = {}) {
  if (!driver || !parse || !site || !email || !link || typeof save !== 'function') {
    return { status: 'stopped', reason: 'invalid-input', saved: 0, total: 0 };
  }

  let saved = 0;
  let total = 0;

  try {
    await driver.openLink(link);
    await driver.submitEmail(email);
    const r = await parse.redemption(await driver.redemptionHtml(), site);

    if (!r.ok) {
      await driver.closeTab();
      return { status: 'stopped', reason: r.reason === 'alert' ? 'email-rejected' : r.reason, saved: 0, total: 0 };
    }

    total = r.total;
    const first = r.cards.find(c => c.canOpen);
    if (!first) {
      await driver.closeTab();
      return { status: 'stopped', reason: 'no-open-button', saved: 0, total };
    }

    await driver.sleep(delayMs);
    await driver.openCard(first.index);

    let expected = 1;
    while (true) {
      const p = await parse.print(await driver.printHtml(), site);

      if (!p.ok) {
        return stop('print-' + p.reason, saved, total);
      }
      if (p.index !== expected) {
        return stop('out-of-sequence', saved, total);
      }
      if (p.total !== total) {
        return stop('total-mismatch', saved, total);
      }

      const redemptionCard = r.cards.find(c => c.index === p.index);
      let pdf;
      try {
        pdf = await driver.capturePdf();
      } catch (e) {
        return handleDriverError(e, 'capturePdf', saved, total);
      }

      const cardObj = { index: p.index, title: p.title, listTitle: redemptionCard ? redemptionCard.title : null, code: p.code, pin: p.pin, pdf };
      try {
        await save(cardObj);
      } catch (e) {
        return stop('save-failed', saved, total);
      }

      saved++;

      if (p.done || p.index >= total) {
        await driver.closeTab();
        return p.index === total ? { status: 'complete', saved, total } : stop('ended-early', saved, total);
      }

      await driver.sleep(delayMs);
      try {
        await driver.clickNext();
      } catch (e) {
        return handleDriverError(e, 'clickNext', saved, total);
      }

      expected++;
    }
  } catch (e) {
    const reason = e.code === 'RATE_LIMITED' ? 'rate-limited' : e.code === 'LOGGED_OUT' ? 'logged-out' : 'driver-error';
    await driver.closeTab();
    return { status: 'stopped', reason, saved, total };
  }

  function stop(reason, s, t) {
    (async () => { try { await driver.closeTab(); } catch (_) {} })();
    return { status: 'stopped', reason, saved: s, total: t };
  }

  function handleDriverError(e, context, s, t) {
    const reason = e.code === 'RATE_LIMITED' ? 'rate-limited' : e.code === 'LOGGED_OUT' ? 'logged-out' : 'driver-error';
    (async () => { try { await driver.closeTab(); } catch (_) {} })();
    return { status: 'stopped', reason, saved: s, total: t };
  }
}
