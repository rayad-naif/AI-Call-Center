'use strict';
/* Create MongoDB indexes once (they are also created on first use). */
const config = require('../server/config');
const { createMongoStore } = require('../server/store/mongo');

(async () => {
  const cfg = config.load();
  if (!cfg.mongoUri) { console.error('Set AI_CALL_CENTER_PLUS_MONGODB_URI (or MONGODB_URI) first'); process.exit(1); }
  const store = createMongoStore(cfg.mongoUri, cfg.mongoDb);
  await store.ensureIndexes();
  await store.close();
  console.log('Indexes ready on ' + cfg.mongoDb);
})().catch((e) => { console.error(e); process.exit(1); });
