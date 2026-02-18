const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const { sendBatch, startMonitor, getScreenshot } = require('./waSender');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sample-csv', (req, res) => {
  const p = path.join(__dirname, 'sample.csv');
  return res.download(p, 'sample.csv');
});

const upload = multer({ storage: multer.memoryStorage() });

const RowSchema = z.object({
  phone: z.string().min(1),
  message: z.string().min(1),
  name: z.string().optional(),
});

function normalizePhone(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^'+/, '')
    .replace(/^"|"$/g, '');
  // Keep digits only
  const digits = s.replace(/\D/g, '');
  return digits;
}

app.post('/api/parse-csv', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const csvText = req.file.buffer.toString('utf8');

    const tryParse = (delimiter) =>
      parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
      });

    let records;
    try {
      const firstLine = (csvText.split(/\r?\n/)[0] || '').trim();
      const delimiterGuess = firstLine.includes('\t') ? '\t' : ',';
      records = tryParse(delimiterGuess);
    } catch {
      records = tryParse('\t');
    }

    const rows = [];
    const errors = [];

    records.forEach((r, idx) => {
      const phone = normalizePhone(
        r.phone ??
        r.Phone ??
        r.PHONE ??
        r['phone no.'] ??
        r['phone no'] ??
        r['Phone No.'] ??
        r['Phone No'] ??
        r['Phone Number'] ??
        r['phone number'] ??
        r.number ??
        r.Number ??
        r['Mobile'] ??
        r['mobile']
      );
      const message = (r.message ?? r.Message ?? r.MESSAGE ?? '').toString();
      const name = (r.name ?? r.Name ?? r.NAME ?? '').toString() || undefined;

      const parsed = RowSchema.safeParse({ phone, message, name });
      if (!parsed.success) {
        errors.push({ row: idx + 1, issues: parsed.error.issues });
        return;
      }

      rows.push({ id: idx + 1, phone, message, name });
    });

    return res.json({ rows, errors, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to parse CSV' });
  }
});

const SendRequestSchema = z.object({
  rows: z.array(
    z.object({
      phone: z.string().min(5),
      message: z.string().min(1),
      name: z.string().optional(),
    })
  ),
  delayMs: z.number().int().min(500).max(30000).optional(),
});

const jobs = new Map();

app.post('/api/send', async (req, res) => {
  const parsed = SendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
  }

  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows, delayMs } = parsed.data;

  const job = {
    id: jobId,
    status: 'running',
    total: rows.length,
    done: 0,
    ok: 0,
    failed: 0,
    events: [],
    startedAt: Date.now(),
    finishedAt: null,
  };

  jobs.set(jobId, job);
  res.json({ jobId });

  // Fire and forget
  try {
    await sendBatch({
      rows,
      delayMs: delayMs ?? 1500,
      onProgress: (evt) => {
        job.done += 1;
        if (evt.ok) job.ok += 1;
        else job.failed += 1;
        job.events.push({
          t: Date.now(),
          index: evt.index,
          phone: evt.row.phone,
          ok: evt.ok,
          error: evt.error,
        });
        if (job.events.length > 200) job.events.shift();
      },
    });
    job.status = 'finished';
    job.finishedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.finishedAt = Date.now();
    job.events.push({ t: Date.now(), ok: false, error: e.message || String(e) });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

// ── Monitor Mode ─────────────────────────────────────────────────────────────
let monitorHandle = null;

const MonitorStartSchema = z.object({
  rows: z.array(z.object({
    phone: z.string().min(5),
    message: z.string().min(1),
  })).optional(),
  delayMs: z.number().int().min(500).max(30000).optional(),
});

app.post('/api/monitor/start', async (req, res) => {
  if (monitorHandle && monitorHandle.stats.running) {
    return res.json({ ok: true, already: true });
  }
  const parsed = MonitorStartSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
  }
  const { rows, delayMs } = parsed.data;
  try {
    monitorHandle = await startMonitor({
      rows: rows ?? null,
      delayMs: delayMs ?? 4000,
      onEvent: (evt) => {
        if (evt.done) console.log(`[monitor] all done — total clicks: ${evt.clicks}`);
        else console.log(`[monitor] clicked send (total: ${evt.clicks})`);
      },
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/api/monitor/stop', async (req, res) => {
  if (!monitorHandle) return res.json({ ok: true, was: 'not running' });
  try {
    await monitorHandle.stop();
    monitorHandle = null;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/monitor/status', (req, res) => {
  if (!monitorHandle) {
    return res.json({ running: false, clicks: 0, lastClick: null, current: null });
  }
  const { running, clicks, lastClick, current } = monitorHandle.stats;
  return res.json({ running, clicks, lastClick, current });
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const png = await getScreenshot();
    if (!png) return res.status(404).send('No active browser session');
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
