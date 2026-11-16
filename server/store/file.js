'use strict';
/* Local JSON-file store (development and tests). Not for production. */
const fs = require('fs');
const path = require('path');
const { setPath, getPath, matches, sortDocs } = require('./match');

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function createFileStore(dir) {
  const file = dir ? path.join(dir, 'store.json') : null;
  let data = { agencies: {}, deployments: {}, calls: {}, users: {}, takeovers: {}, domains: {}, events: [] };
  if (file && fs.existsSync(file)) {
    try { data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { console.warn('[store] could not read ' + file); }
  }
  let timer = null;
  function save() {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    }, 50);
  }
  const col = (name) => (data[name] = data[name] || {});

  return {
    kind: 'file',
    async get(c, id) { return clone(col(c)[id] || null); },
    async find(c, filter, opts) {
      opts = opts || {};
      let docs = Object.values(col(c)).filter((d) => matches(d, filter));
      docs = sortDocs(docs, opts.sort);
      if (opts.limit) docs = docs.slice(0, opts.limit);
      return clone(docs);
    },
    async put(c, doc) {
      if (!doc._id) throw new Error('doc._id required');
      doc.updatedAt = new Date().toISOString();
      col(c)[doc._id] = clone(doc);
      save();
      return doc;
    },
    async patch(c, id, set, ops) {
      ops = ops || {};
      const doc = col(c)[id];
      if (!doc) {
        if (!ops.upsert) return null;
        col(c)[id] = { _id: id, createdAt: new Date().toISOString() };
        return this.patch(c, id, set, Object.assign({}, ops, { upsert: false }));
      }
      Object.keys(set || {}).forEach((k) => setPath(doc, k, clone(set[k])));
      Object.keys(ops.inc || {}).forEach((k) => setPath(doc, k, (getPath(doc, k) || 0) + ops.inc[k]));
      Object.keys(ops.push || {}).forEach((k) => {
        const cur = getPath(doc, k) || [];
        const add = ops.push[k];
        let arr = cur.concat(clone(add.each || [add]));
        if (add.slice) arr = arr.slice(add.slice);
        setPath(doc, k, arr);
      });
      doc.updatedAt = new Date().toISOString();
      save();
      return clone(doc);
    },
    async remove(c, id) { delete col(c)[id]; save(); },
    async log(companyId, type, detail, extra) {
      data.events.unshift(Object.assign({ at: new Date().toISOString(), companyId: companyId || null, type, detail: detail || '' }, extra || {}));
      if (data.events.length > 2000) data.events.length = 2000;
      save();
    },
    async events(filter, limit) {
      return clone(data.events.filter((e) => matches(e, filter || {})).slice(0, limit || 50));
    },
    async close() {
      if (timer) { clearTimeout(timer); timer = null; if (file) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } }
    }
  };
}

module.exports = { createFileStore };
