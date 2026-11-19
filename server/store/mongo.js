'use strict';
/* MongoDB Atlas store. The client is cached on `global` so warm serverless
   invocations reuse one connection pool. */
const { MongoClient } = require('mongodb');

const EVENT_TTL_DAYS = 180;
const CALL_TTL_DAYS = Number(process.env.CALL_RETENTION_DAYS || 365);

async function ensureIndexes(d) {
  await Promise.all([
    d.collection('deployments').createIndex({ companyId: 1 }),
    d.collection('calls').createIndex({ companyId: 1, updatedAt: -1 }),
    d.collection('calls').createIndex({ locationId: 1, updatedAt: -1 }),
    d.collection('calls').createIndex({ status: 1, updatedAt: -1 }),
    d.collection('calls').createIndex({ 'sync.state': 1 }),
    d.collection('calls').createIndex({ createdAt: 1 }, { expireAfterSeconds: CALL_TTL_DAYS * 86400 }),
    d.collection('users').createIndex({ email: 1 }, { unique: true }),
    d.collection('users').createIndex({ companyId: 1 }),
    d.collection('takeovers').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    d.collection('takeovers').createIndex({ companyId: 1, createdAt: -1 }),
    d.collection('leads').createIndex({ status: 1, nextAt: 1 }),
    d.collection('leads').createIndex({ locationId: 1, phone: 1, createdAt: -1 }),
    d.collection('leads').createIndex({ locationId: 1, lastCallAt: -1 }),
    d.collection('leads').createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 }),
    d.collection('events').createIndex({ companyId: 1, at: -1 }),
    d.collection('events').createIndex({ at: 1 }, { expireAfterSeconds: EVENT_TTL_DAYS * 86400 })
  ].map((p) => p.catch((e) => console.warn('[store] index not created: ' + e.message))));
}

// Dates are stored as ISO strings for parity with the file store, except TTL fields.
const TTL_FIELDS = { calls: ['createdAt'], takeovers: ['expiresAt'], leads: ['createdAt'] };
function toDb(col, doc) {
  const out = Object.assign({}, doc);
  (TTL_FIELDS[col] || []).forEach((f) => { if (typeof out[f] === 'string') out[f] = new Date(out[f]); });
  return out;
}
// Filters on TTL (Date) fields must compare Dates, not ISO strings.
function filterToDb(col, filter) {
  const fields = TTL_FIELDS[col] || [];
  if (!filter || !fields.length) return filter || {};
  const out = Object.assign({}, filter);
  const conv = (v) => (typeof v === 'string' ? new Date(v) : v);
  fields.forEach((f) => {
    const v = out[f];
    if (v === undefined) return;
    if (v && typeof v === 'object' && !(v instanceof Date)) out[f] = Object.fromEntries(Object.entries(v).map(([op, x]) => [op, Array.isArray(x) ? x.map(conv) : conv(x)]));
    else out[f] = conv(v);
  });
  return out;
}
function fromDb(doc) {
  if (!doc) return null;
  Object.keys(doc).forEach((k) => { if (doc[k] instanceof Date) doc[k] = doc[k].toISOString(); });
  return doc;
}

function createMongoStore(uri, dbName) {
  const cacheKey = '__accMongo:' + uri + ':' + dbName;
  function db() {
    if (!global[cacheKey]) {
      global[cacheKey] = (async () => {
        const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
        await client.connect();
        const d = client.db(dbName);
        await ensureIndexes(d);
        return { client, d };
      })().catch((e) => { global[cacheKey] = null; throw e; });
    }
    return global[cacheKey].then((x) => x.d);
  }
  const c = async (name) => (await db()).collection(name);

  return {
    kind: 'mongo',
    ensureIndexes: async () => ensureIndexes(await db()),
    async get(col, id) { return fromDb(await (await c(col)).findOne({ _id: id })); },
    async find(col, filter, opts) {
      opts = opts || {};
      let cur = (await c(col)).find(filterToDb(col, filter));
      if (opts.sort) cur = cur.sort(opts.sort);
      if (opts.limit) cur = cur.limit(opts.limit);
      return (await cur.toArray()).map(fromDb);
    },
    async put(col, doc) {
      doc.updatedAt = new Date().toISOString();
      await (await c(col)).replaceOne({ _id: doc._id }, toDb(col, doc), { upsert: true });
      return doc;
    },
    async patch(col, id, set, ops) {
      ops = ops || {};
      const update = { $set: Object.assign({}, set || {}, { updatedAt: new Date().toISOString() }) };
      Object.keys(update.$set).forEach((k) => { if (update.$set[k] === undefined) { delete update.$set[k]; (update.$unset = update.$unset || {})[k] = ''; } });
      if (ops.inc) update.$inc = ops.inc;
      if (ops.push) {
        update.$push = {};
        Object.keys(ops.push).forEach((k) => {
          const p = ops.push[k];
          update.$push[k] = p.each ? Object.assign({ $each: p.each }, p.slice ? { $slice: p.slice } : {}) : p;
        });
      }
      if (ops.upsert) update.$setOnInsert = toDb(col, { createdAt: new Date().toISOString() });
      const r = await (await c(col)).findOneAndUpdate({ _id: id }, update, { returnDocument: 'after', upsert: !!ops.upsert });
      return fromDb(r); // driver v6 returns the document itself
    },
    async remove(col, id) { await (await c(col)).deleteOne({ _id: id }); },
    // Lease across all serverless instances: only one caller wins per ttl window.
    async claim(key, ttlMs) {
      const now = Date.now();
      try {
        await (await c('locks')).findOneAndUpdate({ _id: key, until: { $lt: now } }, { $set: { until: now + ttlMs } }, { upsert: true });
        return true;
      } catch (e) {
        if (e.code === 11000) return false; // held by someone else
        throw e;
      }
    },
    async log(companyId, type, detail, extra) {
      await (await c('events')).insertOne(Object.assign({ at: new Date(), companyId: companyId || null, type, detail: detail || '' }, extra || {}));
    },
    async events(filter, limit) {
      const docs = await (await c('events')).find(filter || {}).sort({ at: -1 }).limit(limit || 50).toArray();
      return docs.map((e) => Object.assign({}, e, { _id: undefined, at: e.at.toISOString() }));
    },
    async close() {
      if (!global[cacheKey]) return;
      const x = await global[cacheKey].catch(() => null);
      global[cacheKey] = null;
      if (x) await x.client.close();
    }
  };
}

module.exports = { createMongoStore };
