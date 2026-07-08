const { loadSnapshot } = require('../src/services/codexData');

loadSnapshot()
  .then((snapshot) => {
    const summary = {
      refreshedAt: snapshot.refreshedAt,
      hasPrimaryLimit: Boolean(snapshot.primary),
      hasSecondaryLimit: Boolean(snapshot.secondary),
      localThreads: snapshot.local && snapshot.local.threadsCount,
      todayTokens: snapshot.local && snapshot.local.todayTokens,
      sevenDayTokens: snapshot.local && snapshot.local.sevenDayTokens,
      lifetimeTokens: snapshot.local && snapshot.local.lifetimeTokens,
      detailEvents: snapshot.local && snapshot.local.detailedUsage && snapshot.local.detailedUsage.tokenEvents,
      diagnostics: snapshot.diagnostics.map((item) => item.message)
    };
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
