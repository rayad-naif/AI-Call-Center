'use strict';
/* Vercel serverless entry. vercel.json rewrites every path here. */
const config = require('../server/config');
const { createApp } = require('../server/app');

const cfg = config.load();
const problems = config.validate(cfg);

module.exports = problems.length
  ? (req, res) => {
    console.error('Configuration problems: ' + problems.join('; '));
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('AI Call Center is not configured yet. Set these environment variables:\n - ' + problems.join('\n - '));
  }
  : createApp(cfg);
