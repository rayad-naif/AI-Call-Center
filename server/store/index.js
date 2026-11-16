'use strict';
/* Document store with a tiny, shared API so the app runs on MongoDB Atlas in
   production and on a JSON file in development/tests.

   Collections
     agencies     _id = GHL companyId. OAuth tokens, BYOK keys (encrypted), branding.
     deployments  _id = GHL locationId. One provisioned call center per client.
     calls        _id = Vapi call id. Live state, transcript, QA grade, CRM sync.
     users        portal logins (agency staff + client users).
     takeovers    pending human takeovers (short TTL).
     domains      custom portal domain -> companyId.
     events       activity log.

   API
     get(col, id)                       -> doc | null
     find(col, filter, {sort, limit})   -> docs (filter: equality, {$in}, {$gt}, {$gte}, {$ne}, {$exists})
     put(col, doc)                      -> doc (upsert by _id)
     patch(col, id, set, {push, inc})   -> updated doc | null
     remove(col, id)
     log(companyId, type, detail, extra)
*/
function createStore(cfg) {
  if (cfg.mongoUri) return require('./mongo').createMongoStore(cfg.mongoUri, cfg.mongoDb);
  return require('./file').createFileStore(cfg.dataDir);
}

module.exports = { createStore };
